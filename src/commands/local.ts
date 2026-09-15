import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { ContextDatabase } from "../database/database.js";
import { loadConfig } from "../services/config.js";
import {
  ensureLocalFirstConfig,
  loadLocalFirstConfig,
  type LocalFirstConfig,
} from "../local/config.js";
import {
  selectSafeContext,
  getContextBudget,
  assertContextReady,
  isSensitiveContext,
  type ContextCandidate,
} from "../local/context.js";
import {
  detectPackageManager,
  type PackageManager,
} from "../local/package-manager.js";
import { ProcessRunner } from "../local/process-runner.js";
import { RodsLocalError } from "../local/errors.js";
import {
  filterSanitizedPatch,
  sanitizeWorktree,
} from "../local/worktree-sanitizer.js";
import { resolveLocalOnlyRoute } from "../local/local-only-router.js";
import { collectMachineProfile, type MachineProfile } from "../local/machine-profile.js";
import { OllamaRuntimeAdapter } from "../local/ollama-runtime.js";
import { LMStudioRuntimeAdapter } from "../local/lmstudio-runtime.js";
import { LocalRuntimeRegistry } from "../local/registry.js";
import type {
  DecisionTrace,
  ExecutionHarness,
  ExecutionResult,
  LocalRuntime,
  LocalRuntimeAdapter,
  PowerMode,
  RoutingDecision,
  TaskComplexity,
  ValidationResult,
  ValidationStep,
} from "../local/types.js";

export interface LocalHarness extends ExecutionHarness {
  /**
   * Implementations must invoke external tools only through `runner`; direct
   * shell/process execution is outside this contract. Local inference itself
   * remains separately verified by discovery.
   */
  execute(input: {
    cwd: string;
    prompt: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }, runner: ProcessRunner): Promise<void>;
}

export interface LocalExecutionDependencies {
  runtime: LocalRuntime;
  harness: LocalHarness;
  runner?: ProcessRunner;
  context?: (root: string, task: string) => Promise<ContextCandidate[] | null>;
}

export interface LocalRunOptions {
  root: string;
  task: string;
  powerMode?: PowerMode;
  dryRun?: boolean;
  explain?: boolean;
  signal?: AbortSignal;
}
export type LocalRunReport = ExecutionResult & {
  decision?: RoutingDecision;
  context?: {
    chunks: number;
    estimatedTokens: number;
    excludedDirtyPaths: number;
  };
  dirtyWorkspace: boolean;
};

function trace(
  trace: DecisionTrace[],
  event: DecisionTrace["event"],
  details?: Record<string, unknown>,
): void {
  trace.push({ event, at: new Date().toISOString(), details });
}
function complexity(task: string): TaskComplexity {
  return task.length > 900 || /refactor|migrate|architecture/i.test(task)
    ? "complex"
    : task.length > 250
      ? "medium"
      : "simple";
}
async function output(
  command: string,
  args: string[],
  cwd?: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await new ProcessRunner().run({
    command,
    args,
    cwd,
    timeoutMs: 10_000,
    signal,
  });
  if (result.exitCode !== 0)
    throw new RodsLocalError(
      "PROCESS_FAILED",
      `${command} exited ${result.exitCode}`,
      { result },
    );
  return result.stdout;
}
async function git(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  return output("git", args, root, signal);
}
async function isGit(root: string): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Orchestrator used by the CLI and integration tests. It owns the zero-cloud
 * boundary: no cloud dependency is read or resolved anywhere in this class.
 */
export class LocalExecutionEngine {
  constructor(private readonly dependencies: LocalExecutionDependencies) {}

  async run(options: LocalRunOptions): Promise<LocalRunReport> {
    let root: string;
    try {
      root = await fs.realpath(path.resolve(options.root));
    } catch (cause) {
      throw new RodsLocalError(
        "CONFIGURATION_ERROR",
        "Project root is not accessible",
        {},
        { cause },
      );
    }
    if (!(await isGit(root)))
      throw new RodsLocalError(
        "CONFIGURATION_ERROR",
        "Local execution requires a Git repository",
      );
    // Running must never create or rewrite project configuration. `setup` is
    // the sole mutation boundary for `.ai/config.json`.
    const config = (await loadLocalFirstConfig(root)).config.localFirst;
    const traceEvents: DecisionTrace[] = [];
    const taskComplexity = complexity(options.task);
    trace(traceEvents, "TASK_CLASSIFIED", { complexity: taskComplexity });
    const candidates = await this.loadContext(root, options.task);
    assertContextReady(
      candidates !== null,
      `rods ingest ${JSON.stringify(root)} --project-root ${JSON.stringify(root)}`,
    );
    // Indexed content can have been collected while the primary checkout was
    // dirty.  A worktree at HEAD cannot see it, so never put it in the prompt.
    const dirtyPaths = await dirtyWorkspacePaths(root);
    const contextCandidates = excludeDirtyCandidates(
      candidates!,
      root,
      dirtyPaths,
    );
    const excludedDirtyPaths = candidates!.length - contextCandidates.length;
    if (excludedDirtyPaths)
      trace(traceEvents, "CONTEXT_SELECTED", {
        excludedDirtyPaths,
        reason: "primary-workspace-dirty",
      });
    const runtime = await this.dependencies.runtime.discover(options.signal);
    if (!runtime.installed || !runtime.ready)
      throw new RodsLocalError(
        "LOCAL_RUNTIME_NOT_READY",
        runtime.diagnostics.join("; ") || "Local runtime is not ready",
      );
    const harness = await this.dependencies.harness.discover(options.signal);
    if (!harness.installed || !harness.ready)
      throw new RodsLocalError(
        "HARNESS_NOT_READY",
        harness.diagnostics.join("; ") || "Local harness is not ready",
      );
    const capability = chooseCapability(
      runtime.capabilities,
      taskComplexity,
      options.powerMode ?? config.powerMode,
    );
    const budget = clampContextBudget({
      ...getContextBudget(taskComplexity, capability.contextWindow),
      ...config.contextBudget,
    }, capability.contextWindow);
    const safe = await selectSafeContext(contextCandidates, budget, root);
    trace(traceEvents, "CONTEXT_SELECTED", {
      chunks: safe.chunks.length,
      estimatedTokens: safe.estimatedTokens,
      excludedDirtyPaths,
    });
    trace(traceEvents, "LOCAL_CAPABILITY_DETECTED", {
      capability: capability.id,
    });
    // Do not even read a cloud registry property here: a throwing getter is a
    // deliberate test seam for this architectural boundary.
    const decision = resolveLocalOnlyRoute({
      resolveLocal: () => ({
        runtimeId: this.dependencies.runtime.id,
        harnessId: this.dependencies.harness.id,
        capability,
        powerMode: options.powerMode ?? config.powerMode,
        reason: ["localOnly=true"],
        cloudCalls: 0,
      }),
    });
    trace(traceEvents, "PROVIDER_SELECTED", {
      runtime: decision.runtimeId,
      harness: decision.harnessId,
      cloudCalls: 0,
    });
    const dirtyWorkspace = dirtyPaths.size > 0;
    if (options.dryRun)
      return {
        status: "SUCCESS",
        validation: { status: "UNVALIDATED", steps: [] },
        trace: traceEvents,
        cloudCalls: 0,
        decision,
        context: {
          chunks: safe.chunks.length,
          estimatedTokens: safe.estimatedTokens,
          excludedDirtyPaths,
        },
        dirtyWorkspace,
      };
    const id = randomUUID();
    const worktree = path.join(os.tmpdir(), `rods-local-${id.slice(0, 8)}`);
    const branch = `rods-local/${id.slice(0, 8)}`;
    const artifactDir = path.join(os.tmpdir(), "rods-executions");
    await fs.mkdir(artifactDir, { recursive: true });
    const patchPath = path.join(artifactDir, `${id}.patch`);
    const reportPath = path.join(artifactDir, `${id}.json`);
    let validation: ValidationResult = { status: "UNVALIDATED", steps: [] };
    try {
      // A worktree at HEAD deliberately excludes primary-workspace dirty/untracked files.
      await git(root, ["worktree", "add", "--detach", worktree, "HEAD"], options.signal);
      trace(traceEvents, "WORKTREE_CREATED", { dirtyWorkspace });
      const before = await sanitizeWorktree(worktree);
      const prompt = buildPrompt(options.task, safe.chunks, dirtyWorkspace);
      let lastError: unknown;
      for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
        try {
          trace(traceEvents, "EXECUTION_STARTED", { attempt: attempt + 1 });
          await this.dependencies.harness.execute({
            cwd: worktree,
            prompt,
            timeoutMs: config.timeoutMs,
            signal: options.signal,
          }, this.dependencies.runner ?? new ProcessRunner());
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt === config.maxRetries) throw error;
        }
      }
      if (lastError) throw lastError;
      const after = await sanitizeWorktree(worktree);
      validation = await validate(
        worktree,
        config,
        this.dependencies.runner ?? new ProcessRunner(),
        options.signal,
        traceEvents,
      );
      if (validation.status === "FAILED")
        throw new RodsLocalError(
          "VALIDATION_FAILED",
          "Deterministic validation failed",
          { validation },
        );
      // Intent-to-add is confined to this linked worktree's index. It makes
      // safe harness-created untracked files visible to `git diff` without
      // staging content or touching the primary checkout's index.
      await git(worktree, ["add", "--intent-to-add", "--", "."], options.signal);
      const patch = filterUnsafePatch(
        filterSanitizedPatch(
          filterSanitizedPatch(
            await git(worktree, ["diff", "--binary", "HEAD"], options.signal),
            before,
          ),
          after,
        ),
      );
      await fs.writeFile(patchPath, patch, { mode: 0o600 });
      trace(traceEvents, "PATCH_GENERATED", { filesChanged: patch ? 1 : 0 });
      const result: LocalRunReport = {
        status: "SUCCESS",
        validation: validation as Extract<
          ValidationResult,
          { status: "VALIDATED" | "UNVALIDATED" }
        >,
        trace: traceEvents,
        cloudCalls: 0,
        patchPath,
        reportPath,
        decision,
        context: {
          chunks: safe.chunks.length,
          estimatedTokens: safe.estimatedTokens,
          excludedDirtyPaths,
        },
        dirtyWorkspace,
      };
      trace(traceEvents, "EXECUTION_COMPLETED");
      await fs.writeFile(
        reportPath,
        JSON.stringify(sanitizeReport(result), null, 2),
        { mode: 0o600 },
      );
      return sanitizeReport(result);
    } catch (cause) {
      trace(traceEvents, "EXECUTION_FAILED", {
        code:
          cause instanceof RodsLocalError
            ? cause.code
            : "LOCAL_EXECUTION_FAILED",
      });
      // A failed run has no patch unless it was actually generated. Never
      // advertise a path that does not exist.
      const patchExists = await fs
        .access(patchPath)
        .then(() => true)
        .catch(() => false);
      const failure: LocalRunReport = {
        status: "FAILURE",
        validation,
        trace: traceEvents,
        cloudCalls: 0,
        ...(patchExists ? { patchPath } : {}),
        reportPath,
        decision,
        context: {
          chunks: safe.chunks.length,
          estimatedTokens: safe.estimatedTokens,
          excludedDirtyPaths,
        },
        dirtyWorkspace,
      };
      await fs
        .writeFile(
          reportPath,
          JSON.stringify(
            sanitizeReport({ ...failure, error: safeError(cause) }),
            null,
            2,
          ),
          { mode: 0o600 },
        )
        .catch(() => undefined);
      if (cause instanceof RodsLocalError) {
        const safe = safeError(cause);
        throw new RodsLocalError(
          cause.code,
          safe.message,
          { reportPath },
          { cause },
        );
      }
      throw new RodsLocalError(
        "LOCAL_EXECUTION_FAILED",
        "Local execution failed",
        { reportPath },
        { cause: cause instanceof Error ? cause : undefined },
      );
    } finally {
      // Reset only the disposable worktree index so intent-to-add cannot
      // affect a later artifact operation if cleanup has to be retried.
      try { await git(worktree, ["reset", "--mixed", "HEAD", "--"]); } catch { /* worktree may not exist */ }
      try {
        await git(root, ["worktree", "remove", "--force", worktree]);
      } catch {
        /* artifact was written outside the worktree */
      }
    }
  }

  private async loadContext(
    root: string,
    task: string,
  ): Promise<ContextCandidate[] | null> {
    if (this.dependencies.context) return this.dependencies.context(root, task);
    let db: ContextDatabase | undefined;
    try {
      db = new ContextDatabase(loadConfig(root), { baseDir: root });
      const project = db.findProjectForPath(root);
      if (!project) return null;
      const results: ContextCandidate[] = [];
      for (const row of db.searchProject(task, project.id, 64)) {
        const chunk = db.getChunk(row.id);
        if (chunk)
          results.push({
            path: chunk.path,
            content: chunk.content,
            score: -row.rank,
          });
      }
      return results;
    } catch (cause) {
      // An absent/corrupt/unopenable Context Engine is a readiness failure at
      // this command boundary; never leak a database implementation error.
      throw new RodsLocalError(
        "CONTEXT_NOT_READY",
        `Context Engine index is not ready. Run: rods ingest ${JSON.stringify(root)} --project-root ${JSON.stringify(root)}`,
        {
          ingestCommand: `rods ingest ${JSON.stringify(root)} --project-root ${JSON.stringify(root)}`,
        },
        { cause },
      );
    } finally {
      db?.close();
    }
  }
}

/** Configuration may request a larger budget, but never beyond the selected
 * local model's usable context window. */
function clampContextBudget(
  budget: { maxTokens: number; maxChunks: number; maxFiles: number },
  contextWindow?: number,
): { maxTokens: number; maxChunks: number; maxFiles: number } {
  if (contextWindow === undefined) return budget;
  if (!Number.isInteger(contextWindow) || contextWindow < 1)
    throw new RodsLocalError("CONFIGURATION_ERROR", "Local capability contextWindow must be a positive integer");
  return { ...budget, maxTokens: Math.min(budget.maxTokens, Math.max(1, Math.floor(contextWindow * 0.7))) };
}

async function dirtyWorkspacePaths(root: string): Promise<Set<string>> {
  const [changed, untracked] = await Promise.all([
    git(root, ["diff", "--name-only", "HEAD", "--"]),
    git(root, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  return new Set(
    `${changed}\n${untracked}`
      .split(/\r?\n/)
      .map((entry) => entry.trim().replaceAll("\\", "/"))
      .filter(Boolean),
  );
}

function excludeDirtyCandidates(
  candidates: ContextCandidate[],
  root: string,
  dirty: ReadonlySet<string>,
): ContextCandidate[] {
  return candidates.filter((candidate) => {
    const relative = path
      .relative(root, path.resolve(root, candidate.path))
      .replaceAll(path.sep, "/");
    return !dirty.has(relative);
  });
}

function redact(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*["']?)[^\s,"']+/gi,
      "$1[REDACTED]",
    );
}
function safeError(cause: unknown): { code: string; message: string } {
  return cause instanceof RodsLocalError
    ? { code: cause.code, message: redact(cause.message) }
    : { code: "LOCAL_EXECUTION_FAILED", message: "Local execution failed" };
}
function sanitizeReport<T>(report: T): T {
  return JSON.parse(
    JSON.stringify(report, (_key, value) =>
      typeof value === "string" ? redact(value) : value,
    ),
  ) as T;
}

function chooseCapability(
  capabilities: readonly RoutingDecision["capability"][],
  level: TaskComplexity,
  power: PowerMode,
): RoutingDecision["capability"] {
  const supported = capabilities.filter(
    (entry) =>
      entry.tiers.includes(level) &&
      (power === "auto" || entry.powerModes.includes(power)),
  );
  if (!supported.length)
    throw new RodsLocalError(
      "LOCAL_CAPABILITY_INSUFFICIENT",
      `No local capability supports ${level}/${power}`,
    );
  return [...supported].sort(
    (a, b) => (a.contextWindow ?? 0) - (b.contextWindow ?? 0),
  )[power === "max" || power === "performance" ? supported.length - 1 : 0]!;
}
function buildPrompt(
  task: string,
  chunks: ContextCandidate[],
  dirty: boolean,
): string {
  return `Implement only this task in the current isolated worktree: ${task}\n\nSafe indexed context:\n${chunks.map((chunk) => `FILE: ${chunk.path}\n${chunk.content}`).join("\n\n")}\n\nPrimary workspace has ${dirty ? "uncommitted/untracked changes that are NOT present here" : "no detected dirty changes"}. Do not access outside this worktree.`;
}
/** A harness may create a secret in an otherwise ordinary file; never expose that diff. */
function filterUnsafePatch(patch: string): string {
  return patch
    .split(/(?=^diff --git )/m)
    .filter((section) => {
      const header = /^diff --git a\/(.+) b\/(.+)$/m.exec(section);
      const paths = header ? [header[1]!, header[2]!] : [""];
      return (
        !paths.some((file) =>
          isSensitiveContext({ path: file, content: section }),
        ) && !isSensitiveContext({ path: "", content: section })
      );
    })
    .join("");
}

async function validate(
  root: string,
  config: LocalFirstConfig["localFirst"],
  runner: ProcessRunner,
  signal: AbortSignal | undefined,
  traces: DecisionTrace[],
): Promise<ValidationResult> {
  const manager = detectPackageManager(root);
  const packagePath = path.join(root, "package.json");
  let scripts: Record<string, string> = {};
  try {
    scripts =
      (
        JSON.parse(await fs.readFile(packagePath, "utf8")) as {
          scripts?: Record<string, string>;
        }
      ).scripts ?? {};
  } catch {
    /* no Node package */
  }
  const steps: ValidationStep[] = [];
  const mapping: Array<
    [keyof LocalFirstConfig["localFirst"]["validation"], string]
  > = [
    ["lint", "lint"],
    ["typecheck", "typecheck"],
    ["test", "test"],
    ["build", "build"],
  ];
  for (const [policy, script] of mapping) {
    if (!config.validation[policy]) {
      steps.push({
        name: script,
        status: "skipped",
        reason: "not-allowed-by-policy",
      });
      continue;
    }
    if (!scripts[script]) {
      steps.push({
        name: script,
        status: "skipped",
        reason: "script-not-found",
      });
      continue;
    }
    if (!manager) {
      steps.push({
        name: script,
        status: "skipped",
        reason: "package-manager-not-detected",
      });
      continue;
    }
    trace(traces, "VALIDATION_STARTED", { step: script });
    const command = manager === "npm" ? "npm" : manager;
    const args = manager === "npm" ? ["run", script] : ["run", script];
    try {
      const result = await runner.run({
        command,
        args,
        cwd: root,
        timeoutMs: config.timeoutMs,
        signal,
      });
      if (result.exitCode !== 0) {
        steps.push({
          name: script,
          status: "failed",
          reason: `exit-${result.exitCode}`,
        });
        trace(traces, "VALIDATION_FAILED", { step: script });
        return { status: "FAILED", steps };
      }
      steps.push({ name: script, status: "passed" });
      trace(traces, "VALIDATION_COMPLETED", { step: script });
    } catch (error) {
      steps.push({
        name: script,
        status: "failed",
        reason: error instanceof RodsLocalError ? error.code : "PROCESS_FAILED",
      });
      trace(traces, "VALIDATION_FAILED", { step: script });
      return { status: "FAILED", steps };
    }
  }
  return steps.some((step) => step.status === "passed")
    ? { status: "VALIDATED", steps }
    : { status: "UNVALIDATED", steps };
}

async function executableVersion(command: string): Promise<string | null> {
  try {
    return (
      (await output(command, ["--version"])).trim().split(/\r?\n/)[0] ||
      "installed"
    );
  } catch {
    return null;
  }
}
/** Live Magnitude discovery intentionally never parses human CLI output. */
function liveMagnitude(): LocalRuntime {
  return {
    id: "magnitude",
    async discover() {
      const version = await executableVersion("magnitude");
      return version
        ? {
            installed: true,
            ready: false,
            version,
            capabilities: [],
            diagnostics: [
              "RUNTIME_CONTRACT_UNSUPPORTED: this Magnitude version has no verified structured runtime probe",
            ],
          }
        : {
            installed: false,
            ready: false,
            capabilities: [],
            diagnostics: ["Magnitude is not installed"],
          };
    },
  };
}

/** Discovery-only registry.  Magnitude remains intentionally unverified. */
function liveRuntimeRegistry(): LocalRuntimeRegistry {
  const registry = new LocalRuntimeRegistry();
  registry.register(new OllamaRuntimeAdapter());
  registry.register(new LMStudioRuntimeAdapter());
  registry.register(liveMagnitude());
  return registry;
}
function liveCodex(): LocalHarness {
  return {
    id: "codex",
    async discover() {
      const version = await executableVersion("codex");
      return version
        ? {
            installed: true,
            ready: false,
            diagnostics: [
              "Harness local-runtime connection is not verified",
              "Harness is fail-closed: Git worktree shared .git containment has not been verified",
            ],
          }
        : {
            installed: false,
            ready: false,
            diagnostics: ["Codex is not installed"],
          };
    },
    async execute() {
      throw new RodsLocalError(
        "HARNESS_NOT_READY",
        "Real Codex execution is disabled until a verified local-runtime harness capability and shared Git metadata containment are supplied",
      );
    },
  };
}

export function registerLocalCommands(program: Command): void {
  program
    .command("setup")
    .argument("[path]", "project root", ".")
    .option("--json")
    .description(
      "Configure Local-First defaults without installing external software",
    )
    .action(async (target: string) => {
      const root = path.resolve(target);
      const setup = await ensureLocalFirstConfig(root);
      const doctor = await localDoctor(root);
      console.log(
        JSON.stringify({ configPath: setup.path, ...doctor }, null, 2),
      );
    });
  program
    .command("doctor")
    .argument("[path]", "project root", ".")
    .option("--json")
    .option("--compute", "include machine and verified local runtime discovery")
    .description("Diagnose independent Local-First prerequisites")
    .action(async (target: string, options: { compute?: boolean }) => {
      const report = await localDoctor(path.resolve(target), {
        compute: options.compute,
      });
      console.log(JSON.stringify(report, null, 2));
      if (!report.ready) process.exitCode = 1;
    });
  program
    .command("run")
    .argument("<task>")
    .option("--root <path>", "project root", ".")
    .option("--local-only")
    .option("--dry-run")
    .option("--explain")
    .option("--power <mode>")
    .option("--cloud")
    .option("--hybrid")
    .option("--json")
    .description("Run a safe local-only coding task in an isolated worktree")
    .action(
      async (
        task: string,
        options: {
          root: string;
          localOnly?: boolean;
          dryRun?: boolean;
          explain?: boolean;
          power?: PowerMode;
          cloud?: boolean;
          hybrid?: boolean;
        },
      ) => {
        if (options.cloud || options.hybrid)
          throw new RodsLocalError(
            "FEATURE_NOT_AVAILABLE",
            "Cloud execution is not available in the Local-First MVP",
          );
        if (!options.localOnly)
          throw new RodsLocalError(
            "FEATURE_NOT_AVAILABLE",
            "This MVP requires --local-only",
          );
        if (
          options.power &&
          !["eco", "balanced", "performance", "max", "auto"].includes(
            options.power,
          )
        )
          throw new RodsLocalError("CONFIGURATION_ERROR", "Invalid power mode");
        const engine = new LocalExecutionEngine({
          runtime: liveMagnitude(),
          harness: liveCodex(),
        });
        const cancellation = new AbortController();
        const onSigint = () => cancellation.abort();
        process.once("SIGINT", onSigint);
        let result: LocalRunReport;
        try {
          result = await engine.run({ root: options.root, task, powerMode: options.power, dryRun: options.dryRun, signal: cancellation.signal });
        } finally {
          process.removeListener("SIGINT", onSigint);
        }
        console.log(JSON.stringify(result, null, 2));
        if (options.explain && result.decision)
          console.error(
            `Selected local execution: ${result.decision.reason.join(", ")}`,
          );
      },
    );
}

export type ComputeRuntimeReport = {
  id: string;
  installed: boolean;
  ready: boolean;
  locality: "verified-local" | "unverified" | "remote";
  models: string[];
  proof?: Record<string, unknown>;
  experimental: boolean;
  diagnostics: string[];
};
export type ComputeDoctorReport = {
  machine: MachineProfile;
  runtimes: ComputeRuntimeReport[];
  localOnly: {
    runtimeAvailable: boolean;
    localModelAvailable: boolean;
    codexRouteVerified: false;
    networkIsolationChecked: false;
    e2eReady: false;
  };
};

function supportsVerification(runtime: LocalRuntime): runtime is LocalRuntimeAdapter {
  return "verify" in runtime && typeof runtime.verify === "function";
}

async function computeDoctor(root: string): Promise<ComputeDoctorReport> {
  const registry = liveRuntimeRegistry();
  const [machine, runtimes] = await Promise.all([
    collectMachineProfile(root),
    Promise.all(
      registry.list().map(async (runtime): Promise<ComputeRuntimeReport> => {
        if (!supportsVerification(runtime)) {
          const discovery = await runtime.discover();
          return {
            id: runtime.id,
            installed: discovery.installed,
            ready: discovery.ready,
            locality: "unverified",
            models: [],
            experimental: true,
            diagnostics: discovery.diagnostics,
          };
        }
        const verification = await runtime.verify();
        const discovery = await runtime.discover();
        return {
          id: runtime.id,
          installed: discovery.installed,
          ready: discovery.ready,
          locality: verification.locality,
          models: verification.modelNames,
          proof: verification.proof,
          experimental: false,
          diagnostics: verification.diagnostics,
        };
      }),
    ),
  ]);
  const verified = runtimes.filter(
    (runtime) => runtime.locality === "verified-local",
  );
  return {
    machine,
    runtimes,
    localOnly: {
      runtimeAvailable: verified.length > 0,
      localModelAvailable: verified.some((runtime) => runtime.models.length > 0),
      codexRouteVerified: false,
      networkIsolationChecked: false,
      e2eReady: false,
    },
  };
}

export async function localDoctor(root: string, options: { compute?: boolean } = {}): Promise<{
  ready: boolean;
  core: Record<string, unknown>;
  localRuntime: Record<string, unknown>;
  localModels: Record<string, unknown>;
  harness: Record<string, unknown>;
  workspace: Record<string, unknown>;
  validation: Record<string, unknown>;
  compute?: ComputeDoctorReport;
}> {
  const runtime = await liveMagnitude().discover();
  const harness = await liveCodex().discover();
  let manager: PackageManager | null = null;
  let managerError: string | null = null;
  try {
    manager = detectPackageManager(root);
  } catch (error) {
    managerError = error instanceof Error ? error.message : String(error);
  }
  const localConfig = await loadLocalFirstConfig(root);
  let discoveredScripts: string[] = [];
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(root, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    discoveredScripts = ["lint", "typecheck", "test", "build"].filter((name) =>
      Boolean(parsed.scripts?.[name]),
    );
  } catch {
    /* a package manifest is optional */
  }
  const indexed = (() => {
    try {
      const db = new ContextDatabase(loadConfig(root), { baseDir: root });
      const found = !!db.findProjectForPath(root);
      db.close();
      return found;
    } catch {
      return false;
    }
  })();
  const gitReady = await isGit(root);
  const report: {
    ready: boolean;
    core: Record<string, unknown>;
    localRuntime: Record<string, unknown>;
    localModels: Record<string, unknown>;
    harness: Record<string, unknown>;
    workspace: Record<string, unknown>;
    validation: Record<string, unknown>;
    compute?: ComputeDoctorReport;
  } = {
    ready: false,
    core: { node: process.version, git: gitReady, contextEngine: indexed },
    localRuntime: {
      installed: runtime.installed,
      ready: runtime.ready,
      version: runtime.installed ? runtime.version : undefined,
      diagnostics: runtime.diagnostics,
      failClosed: true,
    },
    localModels: {
      available: false,
      diagnostics: ["Unknown: no verified structured Magnitude model probe"],
    },
    harness: {
      installed: harness.installed,
      ready: harness.ready,
      diagnostics: harness.diagnostics,
      failClosed: true,
      realExecutionEnabled: false,
    },
    workspace: { gitRepository: gitReady, worktreeSupported: gitReady },
    validation: {
      packageManager: manager,
      diagnostic: managerError,
      discoveredStandardScripts: discoveredScripts,
      policyPermission: localConfig.config.localFirst.validation,
      configPath: localConfig.path,
    },
  };
  if (options.compute) report.compute = await computeDoctor(root);
  return report;
}
