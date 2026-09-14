import fs from "node:fs";
import path from "node:path";
import { buildIgnoreFilter } from "../utils/ignore.js";
import type { ContextBudget, TaskComplexity } from "./types.js";
import { RodsLocalError } from "./errors.js";

export interface ContextCandidate {
  path: string;
  content: string;
  score?: number;
}
export interface ContextSelection {
  chunks: ContextCandidate[];
  estimatedTokens: number;
  excluded: Array<{ path: string; reason: string }>;
}

const SENSITIVE_PATH =
  /(^|\/)(?:\.env(?:\..*)?|\.npmrc|[^/]*\.(?:pem|key|p12|pfx|jks|kdbx)|(?:credentials?|secrets?)[^/]*|\.ssh\/(?:id_[^/]+|config|known_hosts)|(?:ssh\/)?id_(?:rsa|dsa|ecdsa|ed25519)|keystore[^/]*)$/i;
const SECRET_CONTENT = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/i,
  /(?:api[_-]?key|access[_-]?token|token|secret|password|_auth(?:token)?)\s*[:=]\s*['\"]?[A-Za-z0-9_\-\/+=]{12,}/i,
  /\bbearer\s+[A-Za-z0-9._~+\/-]{12,}/i,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/,
];

export function isSensitiveContext(candidate: ContextCandidate): string | null {
  if (SENSITIVE_PATH.test(candidate.path.replaceAll(path.sep, "/")))
    return "sensitive-path";
  if (SECRET_CONTENT.some((pattern) => pattern.test(candidate.content)))
    return "secret-pattern";
  return null;
}

export function getContextBudget(
  complexity: TaskComplexity,
  contextWindow?: number,
): ContextBudget {
  const defaults: Record<TaskComplexity, ContextBudget> = {
    simple: { maxTokens: 4_000, maxChunks: 8, maxFiles: 5 },
    medium: { maxTokens: 10_000, maxChunks: 20, maxFiles: 12 },
    complex: { maxTokens: 20_000, maxChunks: 40, maxFiles: 24 },
  };
  const base = defaults[complexity];
  if (contextWindow === undefined) return base;
  if (!Number.isInteger(contextWindow) || contextWindow < 1)
    throw new RodsLocalError(
      "CONFIGURATION_ERROR",
      "contextWindow must be a positive integer",
    );
  return assertContextBudget({
    ...base,
    maxTokens: Math.min(
      base.maxTokens,
      Math.max(1, Math.floor(contextWindow * 0.7)),
    ),
  });
}

export async function selectSafeContext(
  candidates: ContextCandidate[],
  budget: ContextBudget,
  root?: string,
): Promise<ContextSelection> {
  assertContextBudget(budget);
  const normalizedRoot = root
    ? await fs.promises.realpath(path.resolve(root))
    : undefined;
  const ignore = normalizedRoot ? buildRodsIgnoreFilter(normalizedRoot) : null;
  const selected: ContextCandidate[] = [];
  const excluded: ContextSelection["excluded"] = [];
  const files = new Set<string>();
  let tokens = 0;
  for (const candidate of [...candidates].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0),
  )) {
    const normalized = await normalizeContextCandidate(
      candidate,
      normalizedRoot,
    );
    if (!normalized) {
      excluded.push({ path: candidate.path, reason: "unsafe-path" });
      continue;
    }
    // The shared ignore filter accepts filesystem paths; retain a normalized
    // relative path for all subsequent security and budget decisions.
    const ignored = ignore?.shouldIgnore(
      path.resolve(normalizedRoot!, normalized.path),
    );
    const sensitive = isSensitiveContext(normalized);
    if (ignored || sensitive) {
      excluded.push({
        path: normalized.path,
        reason: ignored ? "ignored" : sensitive!,
      });
      continue;
    }
    const estimate = estimateTokens(normalized.content);
    if (
      selected.length >= budget.maxChunks ||
      tokens + estimate > budget.maxTokens ||
      (!files.has(normalized.path) && files.size >= budget.maxFiles)
    ) {
      excluded.push({ path: normalized.path, reason: "budget" });
      continue;
    }
    selected.push(normalized);
    files.add(normalized.path);
    tokens += estimate;
  }
  return { chunks: selected, estimatedTokens: tokens, excluded };
}

/** Returns a project-relative, slash-normalized path; candidates outside root are unsafe. */
export async function normalizeContextCandidate(
  candidate: ContextCandidate,
  root?: string,
): Promise<ContextCandidate | null> {
  if (!root)
    return {
      ...candidate,
      path: path.normalize(candidate.path).replaceAll(path.sep, "/"),
    };
  const absolute = path.resolve(root, candidate.path);
  try {
    // lstat is intentional: stat/realpath alone would follow a malicious link.
    const entry = await fs.promises.lstat(absolute);
    if (entry.isSymbolicLink() || !entry.isFile()) return null;
    const canonical = await fs.promises.realpath(absolute);
    const canonicalRelative = path.relative(root, canonical);
    if (
      canonicalRelative === ".." ||
      canonicalRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(canonicalRelative)
    )
      return null;
    return { ...candidate, path: canonicalRelative.replaceAll(path.sep, "/") };
  } catch {
    // Deleted/stale Context Engine candidates are not safe to send onward.
    return null;
  }
}

export function assertContextBudget(budget: ContextBudget): ContextBudget {
  for (const key of ["maxTokens", "maxChunks", "maxFiles"] as const) {
    if (!Number.isInteger(budget[key]) || budget[key] < 1)
      throw new RodsLocalError(
        "CONFIGURATION_ERROR",
        `Context budget ${key} must be a positive integer`,
      );
  }
  return budget;
}

export function assertContextReady(
  indexed: boolean,
  ingestCommand: string,
): void {
  if (!indexed)
    throw new RodsLocalError(
      "CONTEXT_NOT_READY",
      `Context Engine index is not ready. Run: ${ingestCommand}`,
      { ingestCommand },
    );
}

export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

function buildRodsIgnoreFilter(root: string) {
  const rodsIgnore = path.join(root, ".rodsignore");
  const patterns = fs.existsSync(rodsIgnore)
    ? fs
        .readFileSync(rodsIgnore, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
    : [];
  return buildIgnoreFilter(root, patterns);
}
