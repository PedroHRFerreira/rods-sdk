import fs from "node:fs/promises";
import path from "node:path";

const SENSITIVE_NAME =
  /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|[^/]*\.(?:pem|key|p12|pfx|jks|kdbx)|(?:credentials?|secrets?)[^/]*|\.ssh\/(?:id_[^/]+|config|known_hosts)|(?:ssh\/)?id_(?:rsa|dsa|ecdsa|ed25519)|keystore[^/]*)$/i;

// Keep this check deliberately local to the quarantine boundary.  A file can
// have an innocuous name and still contain a credential produced by a harness.
// Do not report its name or contents once it is quarantined.
const SECRET_CONTENT = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/i,
  /(?:api[_-]?key|access[_-]?token|token|secret|password|_auth(?:token)?)\s*[:=]\s*['\"]?[A-Za-z0-9_\-\/+=]{12,}/i,
  /\bbearer\s+[A-Za-z0-9._~+\/-]{12,}/i,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/,
];
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

export interface SanitizationManifest {
  removedCount: number;
  /** Deliberately redacted: reports categories, never sensitive paths. */
  removed: Array<{ category: "sensitive-file" | "secret-content" | "symlink" }>;
  /** Kept for compatibility; symlinks are now removed, never skipped. */
  skippedSymlinkCount: number;
}

// Sensitive paths must not surface in the report or public manifest. Keep the
// association private and allow only the patch filter to consume it.
const removedPaths = new WeakMap<SanitizationManifest, Set<string>>();

/**
 * Removes sensitive regular files from an isolated worktree before a harness
 * starts. Symlinks are never followed (including on Windows), so this remains
 * safe on platforms without POSIX process-group semantics.
 */
export async function sanitizeWorktree(
  worktree: string,
): Promise<SanitizationManifest> {
  const root = await fs.realpath(worktree);
  const manifest: SanitizationManifest = {
    removedCount: 0,
    removed: [],
    skippedSymlinkCount: 0,
  };
  const excluded = new Set<string>();
  await visit(root, root, manifest, excluded);
  removedPaths.set(manifest, excluded);
  return manifest;
}

async function visit(
  root: string,
  current: string,
  manifest: SanitizationManifest,
  excluded: Set<string>,
): Promise<void> {
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
    // unlink removes the link itself and never traverses the target. A
    // worktree handed to a harness contains no symlinks, even benign ones.
    if (entry.isSymbolicLink()) {
      await fs.unlink(absolute);
      excluded.add(relative);
      manifest.removedCount++;
      manifest.removed.push({ category: "symlink" });
      continue;
    }
    if (entry.isDirectory()) {
      await visit(root, absolute, manifest, excluded);
      continue;
    }
    if (!entry.isFile()) continue;
    const category = await quarantineCategory(absolute, relative);
    if (!category) continue;
    await fs.unlink(absolute);
    excluded.add(relative);
    manifest.removedCount++;
    manifest.removed.push({ category });
  }
}

async function quarantineCategory(
  absolute: string,
  relative: string,
): Promise<"sensitive-file" | "secret-content" | null> {
  if (SENSITIVE_NAME.test(relative)) return "sensitive-file";
  const stat = await fs.stat(absolute);
  // A large generated regular file is not safe to stream into a report or
  // provider context. Quarantine it rather than leaving a scan gap.
  if (stat.size > MAX_SCAN_BYTES) return "secret-content";
  const content = await fs.readFile(absolute, "utf8");
  return SECRET_CONTENT.some((pattern) => pattern.test(content))
    ? "secret-content"
    : null;
}

/**
 * Remove whole git-diff sections for files quarantined by sanitizeWorktree.
 * The sanitizer's raw paths remain private; callers can safely expose only
 * the resulting patch and the redacted manifest.
 */
export function filterSanitizedPatch(
  patch: string,
  manifest: SanitizationManifest,
): string {
  const excluded = removedPaths.get(manifest);
  if (!excluded?.size || !patch) return patch;
  return patch
    .split(/(?=^diff --git )/m)
    .filter(
      (section) =>
        ![...excluded].some((file) => {
          const normalized = file.replaceAll("\\", "/");
          return (
            section.startsWith(
              `diff --git a/${normalized} b/${normalized}\n`,
            ) ||
            section.includes(`\n--- a/${normalized}\n`) ||
            section.includes(`\n+++ b/${normalized}\n`)
          );
        }),
    )
    .join("");
}
