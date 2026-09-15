import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  assertContextBudget,
  assertContextReady,
  getContextBudget,
  selectSafeContext,
} from "../src/local/context.js";
import {
  ensureLocalFirstConfig,
  mergeLocalFirstConfig,
} from "../src/local/config.js";
import { RodsLocalError } from "../src/local/errors.js";
import { detectPackageManager } from "../src/local/package-manager.js";
import { ProcessRunner } from "../src/local/process-runner.js";
import {
  ExecutionHarnessRegistry,
  LocalRuntimeRegistry,
} from "../src/local/registry.js";
import { resolveLocalOnlyRoute } from "../src/local/local-only-router.js";
import { successfulExecution } from "../src/local/types.js";
import {
  filterSanitizedPatch,
  sanitizeWorktree,
} from "../src/local/worktree-sanitizer.js";
import {
  buildCodexWorkspaceWriteCommand,
  assertHarnessSandboxPolicy,
} from "../src/local/harness-sandbox-policy.js";
import { LocalExecutionEngine } from "../src/commands/local.js";
import { localCliError } from "../src/utils/errors.js";
import { OllamaRuntimeAdapter } from "../src/local/ollama-runtime.js";
import { LMStudioRuntimeAdapter } from "../src/local/lmstudio-runtime.js";
import { collectMachineProfile } from "../src/local/machine-profile.js";
import { CodexHarnessAdapter } from "../src/local/codex-harness.js";
import {
  evaluateLocalOnlyGate,
  UNSUPPORTED_NETWORK_ISOLATION,
} from "../src/local/local-only-gate.js";

test("context selection honors ignore, sensitive-data, and explicit budgets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rods-context-"));
  await fs.writeFile(path.join(root, ".rodsignore"), "ignored.ts\n");
  await Promise.all(
    ["good.ts", ".env", ".npmrc", "request.ts", "ignored.ts", "keys.ts"].map(
      (file) => fs.writeFile(path.join(root, file), "source"),
    ),
  );
  await fs.mkdir(path.join(root, ".ssh"));
  await fs.writeFile(path.join(root, ".ssh", "id_ed25519"), "private");
  const selection = await selectSafeContext(
    [
      {
        path: path.join(root, "good.ts"),
        content: "export const value = 1;",
        score: 10,
      },
      {
        path: path.join(root, ".env"),
        content: "TOKEN=very-secret-value-123",
        score: 9,
      },
      {
        path: path.join(root, ".npmrc"),
        content: "//registry.npmjs.org/:_authToken=very-secret-value-123",
        score: 9,
      },
      {
        path: path.join(root, ".ssh", "id_ed25519"),
        content: "private",
        score: 9,
      },
      {
        path: path.join(root, "request.ts"),
        content: "Authorization: Bearer very-secret-token-value",
        score: 9,
      },
      { path: path.join(root, "ignored.ts"), content: "ignored", score: 8 },
      {
        path: path.join(root, "keys.ts"),
        content: 'const api_key = "abcdefghijklmno123456";',
        score: 7,
      },
    ],
    { maxTokens: 100, maxChunks: 2, maxFiles: 2 },
    root,
  );
  assert.deepEqual(
    selection.chunks.map((chunk) => path.basename(chunk.path)),
    ["good.ts"],
  );
  assert.deepEqual(selection.excluded.map((entry) => entry.reason).sort(), [
    "ignored",
    "secret-pattern",
    "secret-pattern",
    "sensitive-path",
    "sensitive-path",
    "sensitive-path",
  ]);
  assert.equal(getContextBudget("simple", 2_000).maxTokens, 1_400);
  assert.throws(
    () => assertContextBudget({ maxTokens: 0, maxChunks: 1, maxFiles: 1 }),
    (error: unknown) =>
      error instanceof RodsLocalError && error.code === "CONFIGURATION_ERROR",
  );
  assert.throws(
    () => assertContextReady(false, "rods ingest ."),
    (error: unknown) =>
      error instanceof RodsLocalError && error.code === "CONTEXT_NOT_READY",
  );
  const unsafe = await selectSafeContext(
    [{ path: "../outside.ts", content: "nope" }],
    { maxTokens: 10, maxChunks: 1, maxFiles: 1 },
    root,
  );
  assert.deepEqual(unsafe.chunks, []);
  assert.equal(unsafe.excluded[0]?.reason, "unsafe-path");
  const relativeIgnored = await selectSafeContext(
    [{ path: "ignored.ts", content: "ignored" }],
    { maxTokens: 10, maxChunks: 1, maxFiles: 1 },
    root,
  );
  assert.equal(relativeIgnored.excluded[0]?.reason, "ignored");
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), "rods-context-outside-"),
  );
  await fs.writeFile(path.join(outside, "outside.ts"), "outside");
  await fs.symlink(
    path.join(outside, "outside.ts"),
    path.join(root, "linked.ts"),
  );
  const linked = await selectSafeContext(
    [{ path: "linked.ts", content: "outside" }],
    { maxTokens: 10, maxChunks: 1, maxFiles: 1 },
    root,
  );
  assert.equal(linked.excluded[0]?.reason, "unsafe-path");
});

test("package manager detection uses lockfiles and rejects ambiguity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rods-lock-"));
  assert.equal(detectPackageManager(root), null);
  await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9");
  assert.equal(detectPackageManager(root), "pnpm");
  await fs.writeFile(path.join(root, "package-lock.json"), "{}");
  assert.throws(
    () => detectPackageManager(root),
    (error: unknown) =>
      error instanceof RodsLocalError && error.code === "CONFIGURATION_ERROR",
  );
});

test("local-first config merge is idempotent and preserves unrelated settings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rods-config-"));
  await fs.mkdir(path.join(root, ".ai"));
  await fs.writeFile(
    path.join(root, ".ai", "config.json"),
    JSON.stringify({
      project: "keep",
      localFirst: { timeoutMs: 5_000, validation: { test: false } },
    }),
  );
  const first = await ensureLocalFirstConfig(root);
  const second = await ensureLocalFirstConfig(root);
  assert.equal(first.config.project, "keep");
  assert.equal(first.config.localFirst.timeoutMs, 5_000);
  assert.equal(first.config.localFirst.validation.test, false);
  assert.equal(first.config.localFirst.validation.lint, false);
  assert.deepEqual(first.config, second.config);
  assert.equal(
    mergeLocalFirstConfig({ localFirst: { powerMode: "max" } }).localFirst
      .powerMode,
    "max",
  );
  for (const invalid of [
    null,
    [],
    { localFirst: [] },
    { localFirst: { powerMode: "cloud" } },
    { localFirst: { timeoutMs: 0 } },
    { localFirst: { validation: { test: "yes" } } },
    { localFirst: { contextBudget: { maxFiles: 0 } } },
    { localFirst: { localOnlyNetworkPolicy: "disable-security" } },
  ]) {
    assert.throws(
      () => mergeLocalFirstConfig(invalid),
      (error: unknown) =>
        error instanceof RodsLocalError && error.code === "CONFIGURATION_ERROR",
    );
  }
  const malformed = path.join(root, ".ai", "config.json");
  await fs.writeFile(malformed, "{ malformed");
  await assert.rejects(
    ensureLocalFirstConfig(root),
    (error: unknown) =>
      error instanceof RodsLocalError && error.code === "CONFIGURATION_ERROR",
  );
  assert.equal(await fs.readFile(malformed, "utf8"), "{ malformed");

  const noOpRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "rods-config-noop-"),
  );
  const noOpFirst = await ensureLocalFirstConfig(noOpRoot);
  const before = await fs.readFile(noOpFirst.path, "utf8");
  await ensureLocalFirstConfig(noOpRoot);
  assert.equal(await fs.readFile(noOpFirst.path, "utf8"), before);

  const symlinkRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "rods-config-link-"),
  );
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), "rods-config-outside-"),
  );
  await fs.symlink(outside, path.join(symlinkRoot, ".ai"));
  await assert.rejects(
    ensureLocalFirstConfig(symlinkRoot),
    (error: unknown) =>
      error instanceof RodsLocalError && error.code === "CONFIGURATION_ERROR",
  );

  const configLinkRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "rods-config-file-link-"),
  );
  const configOutside = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "rods-config-file-outside-")),
    "config.json",
  );
  await fs.mkdir(path.join(configLinkRoot, ".ai"));
  await fs.writeFile(configOutside, "{}");
  await fs.symlink(
    configOutside,
    path.join(configLinkRoot, ".ai", "config.json"),
  );
  await assert.rejects(
    ensureLocalFirstConfig(configLinkRoot),
    (error: unknown) =>
      error instanceof RodsLocalError && error.code === "CONFIGURATION_ERROR",
  );
});

test("process runner preserves argv boundaries, bounds output, times out and cancels", async () => {
  const runner = new ProcessRunner();
  const normal = await runner.run({
    command: process.execPath,
    args: ["-e", "console.log(process.argv[1])", "hello;not-a-shell"],
    timeoutMs: 2_000,
    maxOutputBytes: 100,
  });
  assert.equal(normal.stdout.trim(), "hello;not-a-shell");
  const bounded = await runner.run({
    command: process.execPath,
    args: ["-e", 'process.stdout.write("x".repeat(100))'],
    timeoutMs: 2_000,
    maxOutputBytes: 10,
  });
  assert.equal(bounded.stdout.length, 10);
  assert.equal(bounded.outputTruncated, true);
  const utf8 = await runner.run({
    command: process.execPath,
    args: ["-e", 'process.stdout.write("€€")'],
    timeoutMs: 2_000,
    maxOutputBytes: 4,
  });
  assert.equal(utf8.stdout, "€");
  assert.equal(Buffer.byteLength(utf8.stdout), 3);
  assert.equal(utf8.outputTruncated, true);
  const splitUtf8 = await runner.run({
    command: process.execPath,
    args: [
      "-e",
      'const b=Buffer.from("€");process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),10)',
    ],
    timeoutMs: 2_000,
    maxOutputBytes: 3,
  });
  assert.equal(splitUtf8.stdout, "€");
  assert.equal(Buffer.byteLength(splitUtf8.stdout), 3);
  assert.equal(splitUtf8.outputTruncated, false);
  const invalidUtf8 = await runner.run({
    command: process.execPath,
    args: ["-e", "process.stdout.write(Buffer.from([0x61, 0xff, 0x62]))"],
    timeoutMs: 2_000,
    maxOutputBytes: 3,
  });
  assert.equal(invalidUtf8.stdout, "ab");
  assert.equal(invalidUtf8.stdout.includes("\uFFFD"), false);
  assert.equal(Buffer.byteLength(invalidUtf8.stdout), 2);
  await assert.rejects(
    runner.run({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 1000)"],
      timeoutMs: 20,
    }),
    (error: unknown) =>
      error instanceof RodsLocalError && error.code === "PROCESS_TIMEOUT",
  );
  const controller = new AbortController();
  controller.abort();
  const marker = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "rods-abort-")),
    "spawned",
  );
  await assert.rejects(
    runner.run({
      command: process.execPath,
      args: [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
      ],
      timeoutMs: 2_000,
      signal: controller.signal,
    }),
    (error: unknown) =>
      error instanceof RodsLocalError && error.code === "PROCESS_FAILED",
  );
  await assert.rejects(fs.access(marker));
  await assert.rejects(
    runner.run({
      command: process.execPath,
      args: ["-e", ""],
      timeoutMs: 2_000,
      maxOutputBytes: -1,
    }),
    (error: unknown) =>
      error instanceof RodsLocalError && error.code === "CONFIGURATION_ERROR",
  );
});

test("execution result constructors prohibit successful failed validation at the type boundary", () => {
  const result = successfulExecution(
    { status: "UNVALIDATED", steps: [] },
    { trace: [], cloudCalls: 0 },
  );
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.validation.status, "UNVALIDATED");
});

test("registries isolate local runtime and harness registrations", () => {
  const runtime = new LocalRuntimeRegistry();
  const harness = new ExecutionHarnessRegistry();
  runtime.register({
    id: "magnitude",
    discover: async () => ({
      installed: true,
      ready: true,
      capabilities: [],
      diagnostics: [],
    }),
  });
  harness.register({
    id: "codex",
    discover: async () => ({ installed: true, ready: true, diagnostics: [] }),
  });
  assert.equal(runtime.get("magnitude").id, "magnitude");
  assert.equal(harness.get("codex").id, "codex");
  assert.throws(
    () => runtime.get("cloud"),
    (error: unknown) =>
      error instanceof RodsLocalError &&
      error.code === "PROVIDER_NOT_AVAILABLE",
  );
});

test("Ollama adapter accepts only documented loopback discovery with a local model", async () => {
  const runtime = new OllamaRuntimeAdapter({
    getJson: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: "qwen2.5-coder:7b" }] }),
    }),
  });
  const verification = await runtime.verify();
  assert.equal(verification.locality, "verified-local");
  assert.deepEqual(verification.modelNames, ["qwen2.5-coder:7b"]);
  assert.equal(verification.proof?.loopback, true);
  assert.equal(verification.proof?.modelVerified, true);
  assert.deepEqual(await runtime.discover(), {
    installed: true,
    ready: true,
    capabilities: [],
    diagnostics: [],
  });
  const remote = new OllamaRuntimeAdapter({
    endpoint: "https://example.test/api/tags",
    getJson: async () => {
      throw new Error("must not request a remote endpoint");
    },
  });
  assert.equal((await remote.verify()).locality, "remote");
});

test("LM Studio adapter stays unverified because localhost can route through LM Link", async () => {
  const runtime = new LMStudioRuntimeAdapter({
    getJson: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          { key: "local-coder", type: "llm", loaded_instances: [{ id: "one" }] },
        ],
      }),
    }),
  });
  const verification = await runtime.verify();
  assert.equal(verification.reachable, true);
  assert.equal(verification.locality, "unverified");
  assert.deepEqual(verification.modelNames, ["local-coder"]);
  assert.deepEqual(await runtime.discover(), {
    installed: true,
    ready: false,
    capabilities: [],
    diagnostics: [
      "LM Studio locality is unverified: LM Link can serve a remote model through localhost",
    ],
  });
});

test("machine profile is read-only and reports core capacity fields", async () => {
  const profile = await collectMachineProfile(process.cwd());
  assert.ok(profile.cpu.cores > 0);
  assert.ok(profile.memory.totalMb > 0);
  assert.ok(profile.memory.availableMb >= 0);
  assert.ok(profile.disk.availableMb >= 0);
});

test("Codex harness refuses to infer a local route from CLI availability", async () => {
  const harness = new CodexHarnessAdapter(async () => "codex-cli 0.154.0");
  const proof = await harness.verifyLocalRoute("ollama");
  assert.equal(proof.harness, "codex");
  assert.equal(proof.provider, undefined);
  assert.equal(proof.endpoint, undefined);
  assert.equal(proof.model, undefined);
  assert.equal(proof.routeVerified, false);
  assert.equal(proof.cloudFallbackEnabled, "unknown");
  assert.equal(proof.cloudCredentialsRequired, "unknown");
  assert.match(proof.diagnostics[0]!, /HARNESS_ROUTE_UNVERIFIED/);
  assert.deepEqual(await harness.discover(), {
    installed: true,
    ready: false,
    diagnostics: proof.diagnostics,
  });
});

test("local-only gate centralizes locality, harness, and network decisions", () => {
  const localityProof = {
    runtime: "ollama",
    endpoint: "http://127.0.0.1:11434/api/tags",
    loopback: true,
    model: "qwen2.5-coder:7b",
    runtimeVerified: true,
    modelVerified: true,
    verifiedAt: "2026-09-14T00:00:00.000Z",
    evidence: [],
  } as const;
  const unverifiableHarness = {
    harness: "codex",
    routeVerified: false,
    cloudFallbackEnabled: "unknown",
    cloudCredentialsRequired: "unknown",
    evidence: [],
    diagnostics: ["HARNESS_ROUTE_UNVERIFIED"],
  } as const;
  assert.deepEqual(
    evaluateLocalOnlyGate({
      localityProof,
      harnessProof: unverifiableHarness,
      networkProof: UNSUPPORTED_NETWORK_ISOLATION,
      networkPolicy: "require-isolation",
    }),
    {
      allowed: false,
      errorCode: "HARNESS_NOT_READY",
      reasons: [
        "Codex provider, endpoint, model, and no-cloud route must be verified",
        "HARNESS_ROUTE_UNVERIFIED",
      ],
    },
  );
  const verifiedHarness = {
    ...unverifiableHarness,
    routeVerified: true,
    cloudFallbackEnabled: false,
    cloudCredentialsRequired: false,
    diagnostics: [],
  } as const;
  assert.equal(
    evaluateLocalOnlyGate({
      localityProof,
      harnessProof: verifiedHarness,
      networkProof: UNSUPPORTED_NETWORK_ISOLATION,
      networkPolicy: "require-isolation",
    }).errorCode,
    "NETWORK_ISOLATION_UNAVAILABLE",
  );
  assert.deepEqual(
    evaluateLocalOnlyGate({
      localityProof,
      harnessProof: verifiedHarness,
      networkProof: {
        supported: true,
        enabled: true,
        loopbackAllowed: true,
        externalNetworkBlocked: true,
        mechanism: "test",
      },
      networkPolicy: "require-isolation",
    }),
    { allowed: true, reasons: [] },
  );
});

test("local-only router cannot resolve a cloud registry path", () => {
  let cloudResolved = false;
  const throwingCloudRegistry = {
    resolve: () => {
      cloudResolved = true;
      throw new Error("cloud registry touched");
    },
  };
  const decision = resolveLocalOnlyRoute({
    resolveLocal: () => ({
      runtimeId: "magnitude",
      harnessId: "codex",
      capability: {
        id: "local",
        label: "Local",
        tiers: ["simple"],
        powerModes: ["eco"],
      },
      powerMode: "eco",
      reason: ["localOnly"],
      cloudCalls: 0,
    }),
    cloudRegistry: throwingCloudRegistry,
  });
  assert.equal(decision.cloudCalls, 0);
  assert.equal(cloudResolved, false);
  assert.throws(
    () =>
      resolveLocalOnlyRoute({
        resolveLocal: () => ({
          runtimeId: "magnitude",
          harnessId: "codex",
          capability: {
            id: "bad",
            label: "Bad",
            tiers: ["simple"],
            powerModes: ["eco"],
          },
          powerMode: "eco",
          reason: [],
          cloudCalls: 1,
        }),
      }),
    (error: unknown) =>
      error instanceof RodsLocalError && error.code === "CONFIGURATION_ERROR",
  );
  assert.equal(cloudResolved, false);
});

test("worktree sanitizer removes sensitive files and returns only a redacted manifest", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rods-worktree-"));
  await fs.mkdir(path.join(root, "nested"));
  await fs.writeFile(path.join(root, ".env"), "TOKEN=secret");
  await fs.writeFile(
    path.join(root, "nested", "credentials.json"),
    '{"secret":true}',
  );
  await fs.writeFile(path.join(root, "source.ts"), "export {};");
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), "rods-sanitizer-outside-"),
  );
  await fs.writeFile(path.join(outside, "outside.txt"), "must not follow");
  await fs.symlink(
    path.join(outside, "outside.txt"),
    path.join(root, "linked.txt"),
  );
  const manifest = await sanitizeWorktree(root);
  assert.equal(manifest.removedCount, 3);
  assert.deepEqual(manifest.removed.map((entry) => entry.category).sort(), [
    "sensitive-file",
    "sensitive-file",
    "symlink",
  ]);
  await assert.rejects(fs.access(path.join(root, ".env")));
  await assert.rejects(
    fs.access(path.join(root, "nested", "credentials.json")),
  );
  await assert.rejects(fs.lstat(path.join(root, "linked.txt")));
  assert.equal(
    await fs.readFile(path.join(outside, "outside.txt"), "utf8"),
    "must not follow",
  );
  await fs.access(path.join(root, "source.ts"));
  const patch = [
    "diff --git a/.env b/.env\n",
    "deleted file mode 100644\n",
    "--- a/.env\n",
    "+++ /dev/null\n",
    "@@ -1 +0,0 @@\n",
    "-TOKEN=secret\n",
    "diff --git a/source.ts b/source.ts\n",
    "--- a/source.ts\n",
    "+++ b/source.ts\n",
    "@@ -1 +1 @@\n",
    "-export {};\n",
    "+export const safe = true;\n",
  ].join("");
  assert.equal(
    filterSanitizedPatch(patch, manifest).includes("TOKEN=secret"),
    false,
  );
  assert.equal(
    filterSanitizedPatch(patch, manifest).includes("source.ts"),
    true,
  );
});

test("worktree sanitizer quarantines ordinary files containing credentials", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rods-worktree-content-"),
  );
  await fs.writeFile(
    path.join(root, "generated.ts"),
    'export const token = "abcdefghijklmnopqrstuvwxyz";',
  );
  await fs.writeFile(path.join(root, "safe.ts"), "export const safe = true;");
  const manifest = await sanitizeWorktree(root);
  assert.equal(manifest.removedCount, 1);
  assert.deepEqual(manifest.removed, [{ category: "secret-content" }]);
  await assert.rejects(fs.access(path.join(root, "generated.ts")));
  const patch =
    'diff --git a/generated.ts b/generated.ts\nnew file mode 100644\n--- /dev/null\n+++ b/generated.ts\n@@ -0,0 +1 @@\n+export const token = "abcdefghijklmnopqrstuvwxyz";\n';
  assert.equal(filterSanitizedPatch(patch, manifest), "");
  await fs.access(path.join(root, "safe.ts"));
});

test("Codex local harness command has a fixed workspace-write sandbox policy", () => {
  assert.deepEqual(buildCodexWorkspaceWriteCommand("Create tests"), {
    command: "codex",
    args: [
      "exec",
      "--strict-config",
      "--config",
      "sandbox_workspace_write.network_access=false",
      "--sandbox",
      "workspace-write",
      "Create tests",
    ],
  });
  assert.throws(
    () =>
      assertHarnessSandboxPolicy({
        sandbox: "workspace-write",
        additionalWritableDirectories: ["/tmp"] as never,
        dangerousBypass: false,
        networkAccess: false,
      }),
    (error: unknown) =>
      error instanceof RodsLocalError && error.code === "SECURITY_BLOCK",
  );
  assert.throws(
    () => buildCodexWorkspaceWriteCommand("  "),
    (error: unknown) =>
      error instanceof RodsLocalError && error.code === "CONFIGURATION_ERROR",
  );
});

test("E2E security fixture produces a validated isolated patch without resolving cloud", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rods-local-run-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  await fs.writeFile(
    path.join(root, "source.ts"),
    "export const before = true;\n",
  );
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
  );
  await fs.writeFile(path.join(root, "package-lock.json"), "{}");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root });
  await fs.mkdir(path.join(root, ".ai"));
  await fs.writeFile(
    path.join(root, ".ai", "config.json"),
    JSON.stringify({ localFirst: { validation: { test: true } } }),
  );
  await fs.writeFile(path.join(root, "dirty.txt"), "primary only");
  let cloudTouched = false;
  const engine = new LocalExecutionEngine({
    runtime: {
      id: "fake-runtime",
      discover: async () => ({
        installed: true,
        ready: true,
        capabilities: [
          {
            id: "fake",
            label: "Fake",
            tiers: ["simple", "medium", "complex"],
            powerModes: ["eco", "balanced", "performance", "max"],
          },
        ],
        diagnostics: [],
      }),
    },
    harness: {
      id: "fake-harness",
      discover: async () => ({ installed: true, ready: true, diagnostics: [] }),
      execute: async ({ cwd }) => {
        assert.equal(
          await fs
            .stat(path.join(cwd, "dirty.txt"))
            .then(() => true)
            .catch(() => false),
          false,
        );
        await fs.writeFile(
          path.join(cwd, "source.ts"),
          "export const after = true;\n",
        );
        await fs.writeFile(
          path.join(cwd, "new-safe.ts"),
          "export const created = true;\n",
        );
        await fs.writeFile(
          path.join(cwd, "generated-secret.ts"),
          'const token = "abcdefghijklmnopqrstuvwxyz";\n',
        );
      },
    },
    gate: async () => ({ allowed: true, reasons: [] }),
    context: async () => [
      { path: "source.ts", content: "export const before = true;", score: 1 },
    ],
    cloudRegistry: {
      resolve: () => {
        cloudTouched = true;
        throw new Error("must not resolve");
      },
    },
  });
  const result = await engine.run({ root, task: "Update source" });
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.validation.status, "VALIDATED");
  assert.equal(result.cloudCalls, 0);
  assert.equal(cloudTouched, false);
  assert.equal(
    await fs.readFile(path.join(root, "source.ts"), "utf8"),
    "export const before = true;\n",
  );
  assert.match(await fs.readFile(result.patchPath!, "utf8"), /after/);
  const generatedPatch = await fs.readFile(result.patchPath!, "utf8");
  assert.match(generatedPatch, /new-safe\.ts/);
  assert.doesNotMatch(
    generatedPatch,
    /generated-secret|abcdefghijklmnopqrstuvwxyz/,
  );
  const report = JSON.parse(await fs.readFile(result.reportPath!, "utf8"));
  assert.equal(report.status, "SUCCESS");
  assert.equal(report.validation.status, "VALIDATED");
  assert.equal(report.cloudCalls, 0);
});

test("E2E security fixture denies an unverified harness before execution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rods-local-gate-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  await fs.writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root });
  let harnessExecuted = false;
  const engine = new LocalExecutionEngine({
    runtime: {
      id: "verified-runtime",
      discover: async () => ({
        installed: true,
        ready: true,
        capabilities: [
          { id: "local", label: "Local", tiers: ["simple"], powerModes: ["eco"] },
        ],
        diagnostics: [],
      }),
    },
    harness: {
      id: "codex",
      discover: async () => ({ installed: true, ready: true, diagnostics: [] }),
      execute: async () => {
        harnessExecuted = true;
      },
    },
    gate: async () => ({
      allowed: false,
      errorCode: "HARNESS_NOT_READY",
      reasons: ["Codex route is unverified"],
    }),
    context: async () => [
      { path: "source.ts", content: "export const value = 1;", score: 1 },
    ],
  });
  await assert.rejects(
    engine.run({ root, task: "Add a test", powerMode: "eco" }),
    (error: unknown) =>
      error instanceof RodsLocalError && error.code === "HARNESS_NOT_READY",
  );
  assert.equal(harnessExecuted, false);
  assert.equal(
    await fs.readFile(path.join(root, "source.ts"), "utf8"),
    "export const value = 1;\n",
  );
  assert.equal(
    execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root })
      .toString()
      .split("worktree ").length - 1,
    1,
  );
});

test("configured context budget is clamped to selected local capability window", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rods-local-budget-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  await fs.writeFile(path.join(root, ".ai-config-placeholder"), "x");
  await fs.writeFile(path.join(root, "source.ts"), "export const x = 1;");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root });
  await fs.mkdir(path.join(root, ".ai"));
  await fs.writeFile(
    path.join(root, ".ai", "config.json"),
    JSON.stringify({ localFirst: { contextBudget: { maxTokens: 99999 } } }),
  );
  let prompt = "";
  const engine = new LocalExecutionEngine({
    runtime: {
      id: "r",
      discover: async () => ({
        installed: true,
        ready: true,
        capabilities: [
          {
            id: "c",
            label: "C",
            contextWindow: 100,
            tiers: ["simple"],
            powerModes: ["eco"],
          },
        ],
        diagnostics: [],
      }),
    },
    harness: {
      id: "h",
      discover: async () => ({ installed: true, ready: true, diagnostics: [] }),
      execute: async ({ prompt: value }) => {
        prompt = value;
      },
    },
    context: async () => [
      { path: "source.ts", content: "a".repeat(2_000), score: 1 },
    ],
  });
  const result = await engine.run({ root, task: "small", powerMode: "eco" });
  assert.equal(result.context?.chunks, 0);
  assert.equal(prompt.includes("FILE:"), false);
});

test("run and dry-run never materialize local config, never read cloud getters, and exclude dirty indexed paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rods-local-boundary-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  await fs.writeFile(
    path.join(root, "source.ts"),
    "export const clean = true;\n",
  );
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root });
  await fs.writeFile(
    path.join(root, "source.ts"),
    'export const dirty = "primary-secret";\n',
  );
  let receivedPrompt = "";
  const dependencies = {
    runtime: {
      id: "fake-runtime",
      discover: async () => ({
        installed: true as const,
        ready: true as const,
        capabilities: [
          {
            id: "fake",
            label: "Fake",
            tiers: ["simple", "medium", "complex"] as const,
            powerModes: ["eco", "balanced", "performance", "max"] as const,
          },
        ],
        diagnostics: [],
      }),
    },
    harness: {
      id: "fake-harness",
      discover: async () => ({
        installed: true as const,
        ready: true as const,
        diagnostics: [],
      }),
      execute: async ({
        prompt,
      }: {
        cwd: string;
        prompt: string;
        timeoutMs: number;
      }) => {
        receivedPrompt = prompt;
      },
    },
    context: async () => [
      {
        path: "source.ts",
        content: 'export const dirty = "primary-secret";',
        score: 1,
      },
    ],
  };
  Object.defineProperty(dependencies, "cloudRegistry", {
    get() {
      throw new Error("cloud registry must not be read");
    },
  });
  const engine = new LocalExecutionEngine(dependencies);
  const dry = await engine.run({ root, task: "Inspect", dryRun: true });
  assert.equal(dry.context?.chunks, 0);
  assert.equal(dry.context?.excludedDirtyPaths, 1);
  assert.equal(
    await fs
      .stat(path.join(root, ".ai", "config.json"))
      .then(() => true)
      .catch(() => false),
    false,
  );
  await engine.run({ root, task: "Inspect" });
  assert.equal(receivedPrompt.includes("primary-secret"), false);
  assert.equal(
    await fs
      .stat(path.join(root, ".ai", "config.json"))
      .then(() => true)
      .catch(() => false),
    false,
  );
});

test("failure reports do not advertise missing patches or persist secret-bearing errors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rods-local-failure-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  await fs.writeFile(path.join(root, "source.ts"), "export {};\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root });
  const engine = new LocalExecutionEngine({
    runtime: {
      id: "fake-runtime",
      discover: async () => ({
        installed: true,
        ready: true,
        capabilities: [
          { id: "fake", label: "Fake", tiers: ["simple"], powerModes: ["eco"] },
        ],
        diagnostics: [],
      }),
    },
    harness: {
      id: "fake-harness",
      discover: async () => ({ installed: true, ready: true, diagnostics: [] }),
      execute: async () => {
        throw new RodsLocalError("PROCESS_FAILED", "token=must-not-persist");
      },
    },
    context: async () => [
      { path: "source.ts", content: "export {};", score: 1 },
    ],
  });
  let thrown: RodsLocalError | undefined;
  try {
    await engine.run({ root, task: "Fail", powerMode: "eco" });
  } catch (error) {
    thrown = error as RodsLocalError;
  }
  assert.equal(thrown?.code, "PROCESS_FAILED");
  const reportPath = (thrown?.details.reportPath as string | undefined)!;
  const report = await fs.readFile(reportPath, "utf8");
  assert.equal(report.includes("must-not-persist"), false);
  assert.equal(report.includes("patchPath"), false);
});

test("local CLI errors expose stable safe codes and categories", () => {
  assert.deepEqual(
    localCliError(new RodsLocalError("CONTEXT_NOT_READY", "token=hidden")),
    { code: "CONTEXT_NOT_READY", message: "token=[REDACTED]", exitCode: 2 },
  );
  assert.deepEqual(localCliError(new Error("secret=hidden")), {
    code: "LOCAL_EXECUTION_FAILED",
    message: "Local execution failed",
    exitCode: 1,
  });
});
