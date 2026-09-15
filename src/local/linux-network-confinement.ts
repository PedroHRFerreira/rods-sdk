import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { RodsLocalError } from "./errors.js";
import { ProcessRunner, type ProcessRequest, type ProcessResult } from "./process-runner.js";
import type { NetworkConfinementProof, NetworkEvidence } from "./types.js";

export type NetworkPolicy = {
  /** The only host endpoint to which the confinement gateway may connect. */
  runtimeEndpoint: string;
  /** Must contain only the runtime endpoint; broad allowlists are rejected. */
  allowedEndpoints: string[];
};

export type ProcessCommand = Pick<
  ProcessRequest,
  "command" | "args" | "cwd" | "env" | "timeoutMs" | "signal" | "maxOutputBytes" | "input"
> & {
  /** Executables or package roots outside the worktree that must be readable. */
  readOnlyPaths?: string[];
};

export type NetworkConfinementCapability = {
  supported: boolean;
  mechanism?: string;
  diagnostics: string[];
};

export type ConfinedProcessResult = {
  result: ProcessResult;
  proof: NetworkConfinementProof;
};

export interface NetworkConfinement {
  probe(signal?: AbortSignal): Promise<NetworkConfinementCapability>;
  run(policy: NetworkPolicy, command: ProcessCommand): Promise<ConfinedProcessResult>;
}

type ProcessExecutor = Pick<ProcessRunner, "run">;

const BWRAP = "bwrap";
const LOOPBACK_TUNNEL = String.raw`
import net from "node:net";
import { spawn } from "node:child_process";
const [socketPath, portText, command, ...args] = process.argv.slice(1);
const port = Number(portText);
const close = (value) => { try { value.destroy(); } catch {} };
const server = net.createServer((client) => {
  const upstream = net.createConnection(socketPath);
  client.pipe(upstream); upstream.pipe(client);
  client.on("error", () => close(upstream));
  upstream.on("error", () => close(client));
});
server.listen({ host: "127.0.0.1", port }, () => {
  const child = spawn(command, args, { cwd: process.cwd(), env: process.env, stdio: "inherit" });
  child.on("error", () => process.exit(127));
  child.on("exit", (code, signal) => { server.close(() => process.exit(code ?? (signal ? 1 : 0))); });
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, () => child.kill(name));
});
`;

/**
 * Linux-only process confinement. The harness lives in a network namespace
 * with only loopback. A private Unix-socket gateway is the sole path back to
 * the host, and that gateway is fixed to the verified runtime endpoint.
 */
export class LinuxNetworkConfinement implements NetworkConfinement {
  constructor(
    private readonly runner: ProcessExecutor = new ProcessRunner(),
    private readonly platform = process.platform,
  ) {}

  async probe(signal?: AbortSignal): Promise<NetworkConfinementCapability> {
    if (this.platform !== "linux")
      return {
        supported: false,
        diagnostics: ["Linux network confinement is unavailable on this platform"],
      };
    try {
      const result = await this.runner.run({
        command: BWRAP,
        args: ["--unshare-net", "--die-with-parent", "--", "/usr/bin/ip", "link", "show", "lo"],
        timeoutMs: 2_000,
        signal,
        maxOutputBytes: 8 * 1024,
      });
      if (result.exitCode === 0)
        return {
          supported: true,
          mechanism: "bubblewrap-network-namespace",
          diagnostics: ["bubblewrap created an isolated namespace with loopback"],
        };
      return {
        supported: false,
        diagnostics: ["bubblewrap could not create an isolated loopback network namespace"],
      };
    } catch (error) {
      return {
        supported: false,
        diagnostics: [
          `bubblewrap confinement probe failed: ${error instanceof Error ? error.message : "unknown error"}`,
        ],
      };
    }
  }

  async run(
    policy: NetworkPolicy,
    command: ProcessCommand,
  ): Promise<ConfinedProcessResult> {
    const capability = await this.probe(command.signal);
    if (!capability.supported)
      throw new RodsLocalError(
        "NETWORK_ISOLATION_UNAVAILABLE",
        "Linux cannot enforce the required network confinement",
        { diagnostics: capability.diagnostics },
      );
    const runtime = assertStrictLoopbackPolicy(policy);
    const cwd = await resolveDirectory(command.cwd ?? process.cwd());
    assertCommandPath(command.command, cwd, command.readOnlyPaths ?? []);
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "rods-network-"));
    const socketPath = path.join(temporary, "runtime.sock");
    const gateway = await startRuntimeGateway(socketPath, runtime);
    try {
      const result = await this.runner.run({
        ...command,
        command: BWRAP,
        args: confinementArgs(command, cwd, socketPath, runtime.port),
        cwd,
        // No user credentials or inherited cloud configuration reaches the harness.
        env: {},
      });
      if (result.exitCode !== 0 || result.signal)
        throw new RodsLocalError(
          "NETWORK_ISOLATION_FAILED",
          "The confined process could not start or complete inside the network namespace",
          { exitCode: result.exitCode, signal: result.signal, stderr: result.stderr },
        );
      return {
        result,
        proof: {
          supported: true,
          enabled: true,
          mechanism: capability.mechanism ?? "bubblewrap-network-namespace",
          externalNetworkBlocked: true,
          loopbackAllowed: true,
          allowedEndpoints: policy.allowedEndpoints,
          externalConnectionsSucceeded: 0,
          evidence: confinementEvidence(runtime),
        },
      };
    } finally {
      await gateway.close();
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
}

type LoopbackRuntime = { host: "127.0.0.1" | "::1"; port: number };

function assertStrictLoopbackPolicy(policy: NetworkPolicy): LoopbackRuntime {
  if (
    policy.allowedEndpoints.length !== 1 ||
    policy.allowedEndpoints[0] !== policy.runtimeEndpoint
  )
    throw new RodsLocalError(
      "CONFIGURATION_ERROR",
      "Network confinement requires an allowlist containing exactly the verified runtime endpoint",
    );
  let url: URL;
  try {
    url = new URL(policy.runtimeEndpoint);
  } catch {
    throw new RodsLocalError("CONFIGURATION_ERROR", "Runtime endpoint must be an absolute URL");
  }
  const host = url.hostname === "127.0.0.1" || url.hostname === "::1" ? url.hostname : undefined;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535)
    throw new RodsLocalError(
      "CONFIGURATION_ERROR",
      "Network confinement accepts only a loopback runtime endpoint",
    );
  return { host, port };
}

async function resolveDirectory(value: string): Promise<string> {
  const resolved = await fs.realpath(path.resolve(value));
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory())
    throw new RodsLocalError("CONFIGURATION_ERROR", "Confined command cwd must be a directory");
  return resolved;
}

function assertCommandPath(command: string, cwd: string, readOnlyPaths: string[]): void {
  if (!path.isAbsolute(command)) return;
  const permitted = [cwd, "/usr", "/bin", "/lib", "/lib64", "/sbin", "/usr/local", ...readOnlyPaths]
    .map((item) => path.resolve(item));
  if (!permitted.some((root) => command === root || command.startsWith(`${root}${path.sep}`)))
    throw new RodsLocalError(
      "CONFIGURATION_ERROR",
      "Confined command executable is outside the approved read-only paths",
    );
}

function confinementArgs(
  command: ProcessCommand,
  cwd: string,
  socketPath: string,
  port: number,
): string[] {
  const args = [
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-pid",
    "--new-session",
    "--die-with-parent",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",
    "--ro-bind", "/sbin", "/sbin",
    "--ro-bind", "/etc", "/etc",
    "--ro-bind", "/usr/local", "/usr/local",
    "--tmpfs", "/tmp",
    "--tmpfs", "/run",
    "--tmpfs", "/var",
    "--tmpfs", "/home",
    "--tmpfs", "/root",
    "--proc", "/proc",
    "--dev", "/dev",
  ];
  const paths = [cwd, ...(command.readOnlyPaths ?? [])];
  for (const [index, value] of paths.entries()) {
    const resolved = path.resolve(value);
    addDirectories(args, path.dirname(resolved));
    args.push(index === 0 ? "--bind" : "--ro-bind", resolved, resolved);
  }
  addDirectories(args, "/run/rods");
  args.push("--bind", socketPath, "/run/rods/runtime.sock");
  args.push(
    "--clearenv",
    "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
    "--setenv", "HOME", "/tmp",
    "--setenv", "TMPDIR", "/tmp",
    "--chdir", cwd,
    "--",
    process.execPath,
    "-e",
    LOOPBACK_TUNNEL,
    "/run/rods/runtime.sock",
    String(port),
    command.command,
    ...(command.args ?? []),
  );
  return args;
}

function addDirectories(args: string[], target: string): void {
  const segments = path.resolve(target).split(path.sep).filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current += `/${segment}`;
    args.push("--dir", current);
  }
}

async function startRuntimeGateway(socketPath: string, runtime: LoopbackRuntime): Promise<net.Server> {
  const server = net.createServer((client) => {
    const upstream = net.createConnection({ host: runtime.host, port: runtime.port });
    client.pipe(upstream);
    upstream.pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function confinementEvidence(runtime: LoopbackRuntime): NetworkEvidence[] {
  return [
    {
      source: "bubblewrap-network-namespace",
      detail: "Harness network namespace exposes loopback only",
    },
    {
      source: "runtime-gateway",
      detail: `Private gateway is fixed to ${runtime.host}:${runtime.port}`,
    },
  ];
}
