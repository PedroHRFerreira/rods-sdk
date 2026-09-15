import fs from "node:fs/promises";
import path from "node:path";
import type { ContextBudget, LocalOnlyNetworkPolicy, PowerMode } from "./types.js";
import { RodsLocalError } from "./errors.js";

export interface LocalFirstConfig {
  localFirst: {
    runtime?: string;
    harness?: string;
    localOnlyNetworkPolicy: LocalOnlyNetworkPolicy;
    powerMode: PowerMode;
    timeoutMs: number;
    maxRetries: number;
    contextBudget?: Partial<ContextBudget>;
    validation: {
      lint: boolean;
      typecheck: boolean;
      test: boolean;
      build: boolean;
    };
  };
}

/** Validation is opt-in: discovery may report candidates but setup must never enable scripts. */
export const DEFAULT_LOCAL_FIRST_CONFIG: LocalFirstConfig = {
  localFirst: {
    powerMode: "auto",
    localOnlyNetworkPolicy: "require-isolation",
    timeoutMs: 120_000,
    maxRetries: 1,
    validation: { lint: false, typecheck: false, test: false, build: false },
  },
};

export function mergeLocalFirstConfig(
  input: unknown,
): Record<string, unknown> & LocalFirstConfig {
  const base = assertRecord(input, "Configuration");
  const rawLocalFirst = base.localFirst;
  const existing =
    rawLocalFirst === undefined
      ? {}
      : assertRecord(rawLocalFirst, "localFirst");
  const rawValidation = existing.validation;
  const validation =
    rawValidation === undefined
      ? {}
      : assertRecord(rawValidation, "localFirst.validation");
  validateLocalFirst(existing, validation);
  return {
    ...base,
    localFirst: {
      ...DEFAULT_LOCAL_FIRST_CONFIG.localFirst,
      ...existing,
      validation: {
        ...DEFAULT_LOCAL_FIRST_CONFIG.localFirst.validation,
        ...validation,
      },
    },
  } as Record<string, unknown> & LocalFirstConfig;
}

/** Idempotently adds missing Local-First defaults while preserving user config. */
export async function ensureLocalFirstConfig(root: string): Promise<{
  path: string;
  config: Record<string, unknown> & LocalFirstConfig;
}> {
  const projectRoot = await canonicalProjectRoot(root);
  const aiPath = path.join(projectRoot, ".ai");
  const configPath = path.join(aiPath, "config.json");
  await assertSafeConfigPath(projectRoot, aiPath, configPath);
  let raw: unknown = {};
  let serializedBefore: string | undefined;
  try {
    serializedBefore = await fs.readFile(configPath, "utf8");
    raw = JSON.parse(serializedBefore);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new RodsLocalError(
        "CONFIGURATION_ERROR",
        `Invalid configuration at ${configPath}`,
        {},
        { cause: error },
      );
  }
  const config = mergeLocalFirstConfig(raw);
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  if (serializedBefore !== serialized) {
    await ensureSafeConfigDirectory(projectRoot, aiPath);
    await writeConfigAtomically(projectRoot, aiPath, configPath, serialized);
  }
  return { path: configPath, config };
}

/**
 * Read Local-First configuration without changing the project.  Only `setup`
 * is allowed to materialize `.ai/config.json`; `run`, `doctor`, and dry-runs
 * must be safe to invoke in a pristine checkout.
 */
export async function loadLocalFirstConfig(root: string): Promise<{
  path: string;
  config: Record<string, unknown> & LocalFirstConfig;
}> {
  const projectRoot = await canonicalProjectRoot(root);
  const aiPath = path.join(projectRoot, ".ai");
  const configPath = path.join(aiPath, "config.json");
  await assertSafeConfigPath(projectRoot, aiPath, configPath);
  try {
    return {
      path: configPath,
      config: mergeLocalFirstConfig(
        JSON.parse(await fs.readFile(configPath, "utf8")),
      ),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { path: configPath, config: mergeLocalFirstConfig({}) };
    if (error instanceof RodsLocalError) throw error;
    throw new RodsLocalError(
      "CONFIGURATION_ERROR",
      `Invalid configuration at ${configPath}`,
      {},
      { cause: error },
    );
  }
}

async function canonicalProjectRoot(root: string): Promise<string> {
  try {
    return await fs.realpath(path.resolve(root));
  } catch (cause) {
    throw new RodsLocalError(
      "CONFIGURATION_ERROR",
      `Project root is not accessible: ${root}`,
      {},
      { cause },
    );
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function assertSafeConfigPath(
  root: string,
  aiPath: string,
  configPath: string,
): Promise<void> {
  if (!isInside(root, aiPath) || !isInside(root, configPath))
    throw new RodsLocalError(
      "CONFIGURATION_ERROR",
      "Configuration path escapes project root",
    );
  for (const candidate of [aiPath, configPath]) {
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink())
        throw new RodsLocalError(
          "CONFIGURATION_ERROR",
          `Refusing symbolic-link configuration path: ${candidate}`,
        );
      const real = await fs.realpath(candidate);
      if (!isInside(root, real))
        throw new RodsLocalError(
          "CONFIGURATION_ERROR",
          `Configuration path escapes project root: ${candidate}`,
        );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
}

async function ensureSafeConfigDirectory(
  root: string,
  aiPath: string,
): Promise<void> {
  // Node has no portable openat/O_NOFOLLOW equivalent for a directory FD. We
  // validate immediately before each operation and never follow a config-file
  // symlink; hostile concurrent directory replacement remains an OS-level
  // TOCTOU limitation that callers should avoid by owning the project tree.
  await fs.mkdir(aiPath, { recursive: true, mode: 0o700 });
  await assertSafeConfigPath(root, aiPath, path.join(aiPath, "config.json"));
}

async function writeConfigAtomically(
  root: string,
  aiPath: string,
  configPath: string,
  serialized: string,
): Promise<void> {
  await assertSafeConfigPath(root, aiPath, configPath);
  const temporary = path.join(
    aiPath,
    `.config.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let handle: fs.FileHandle | undefined;
  try {
    // Exclusive creation and rename prevent partial config files and do not
    // dereference a config.json symlink at the destination.
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertSafeConfigPath(root, aiPath, configPath);
    await fs.rename(temporary, configPath);
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    throw cause;
  }
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RodsLocalError(
      "CONFIGURATION_ERROR",
      `${label} must be an object`,
    );
  return value as Record<string, unknown>;
}

function validateLocalFirst(
  config: Record<string, unknown>,
  validation: Record<string, unknown>,
): void {
  if (
    config.runtime !== undefined &&
    (typeof config.runtime !== "string" || !config.runtime.trim())
  )
    invalid("localFirst.runtime must be a non-empty string");
  if (
    config.harness !== undefined &&
    (typeof config.harness !== "string" || !config.harness.trim())
  )
    invalid("localFirst.harness must be a non-empty string");
  if (
    config.localOnlyNetworkPolicy !== undefined &&
    !["require-isolation"].includes(
      config.localOnlyNetworkPolicy as string,
    )
  )
    invalid("localFirst.localOnlyNetworkPolicy is invalid");
  if (
    config.powerMode !== undefined &&
    !["eco", "balanced", "performance", "max", "auto"].includes(
      config.powerMode as string,
    )
  )
    invalid("localFirst.powerMode is invalid");
  if (
    config.timeoutMs !== undefined &&
    (!Number.isInteger(config.timeoutMs) || (config.timeoutMs as number) < 1)
  )
    invalid("localFirst.timeoutMs must be a positive integer");
  if (
    config.maxRetries !== undefined &&
    (!Number.isInteger(config.maxRetries) || (config.maxRetries as number) < 0)
  )
    invalid("localFirst.maxRetries must be a non-negative integer");
  if (config.contextBudget !== undefined) {
    const budget = assertRecord(
      config.contextBudget,
      "localFirst.contextBudget",
    );
    for (const key of ["maxTokens", "maxChunks", "maxFiles"])
      if (
        budget[key] !== undefined &&
        (!Number.isInteger(budget[key]) || (budget[key] as number) < 1)
      )
        invalid(`localFirst.contextBudget.${key} must be a positive integer`);
  }
  for (const key of ["lint", "typecheck", "test", "build"])
    if (validation[key] !== undefined && typeof validation[key] !== "boolean")
      invalid(`localFirst.validation.${key} must be a boolean`);
}

function invalid(message: string): never {
  throw new RodsLocalError("CONFIGURATION_ERROR", message);
}
