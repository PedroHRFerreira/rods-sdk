import { spawn, type ChildProcess } from "node:child_process";
import { RodsLocalError } from "./errors.js";

export interface ProcessRequest {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  input?: string;
}
export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
}

const TERMINATION_GRACE_MS = 250;

/** Runs external processes with bounded output and bounded cancellation. */
export class ProcessRunner {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    if (
      !request.command ||
      !Number.isInteger(request.timeoutMs) ||
      request.timeoutMs < 1
    )
      throw new RodsLocalError(
        "CONFIGURATION_ERROR",
        "Process command and positive timeout are required",
      );
    const max = request.maxOutputBytes ?? 256 * 1024;
    if (!Number.isInteger(max) || max < 0)
      throw new RodsLocalError(
        "CONFIGURATION_ERROR",
        "maxOutputBytes must be a non-negative integer",
      );
    // Do not launch even briefly when the caller has already cancelled its work.
    if (request.signal?.aborted)
      throw new RodsLocalError(
        "PROCESS_FAILED",
        `${request.command} cancelled before start`,
      );
    return await new Promise<ProcessResult>((resolve, reject) => {
      const started = Date.now();
      const stdout = new Utf8OutputCollector();
      const stderr = new Utf8OutputCollector();
      let bytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;
      let terminating = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let hardStopTimer: NodeJS.Timeout | undefined;
      let child: ChildProcess;
      const append = (stream: Utf8OutputCollector, value: Buffer) => {
        const available = max - bytes;
        if (available <= 0) {
          truncated = true;
          stream.discard(value);
          return;
        }
        const captured = stream.append(value, available);
        bytes += captured;
        if (stream.truncated) truncated = true;
      };
      const abort = () => terminate();
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (hardStopTimer) clearTimeout(hardStopTimer);
        request.signal?.removeEventListener("abort", abort);
        fn();
      };
      try {
        // Detached gives POSIX processes their own group so a timeout can stop descendants too.
        child = spawn(request.command, request.args ?? [], {
          cwd: request.cwd,
          env: request.env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
      } catch (cause) {
        reject(
          new RodsLocalError(
            "PROCESS_FAILED",
            `Failed to start ${request.command}: ${(cause as Error).message}`,
            {},
            { cause },
          ),
        );
        return;
      }
      const terminate = () => {
        if (terminating || child.exitCode !== null || child.signalCode !== null)
          return;
        terminating = true;
        killTree(child, "SIGTERM");
        forceKillTimer = setTimeout(
          () => killTree(child, "SIGKILL"),
          TERMINATION_GRACE_MS,
        );
        // Do not leave the caller waiting forever if an OS or child-process edge case omits close.
        hardStopTimer = setTimeout(
          () =>
            finish(() =>
              reject(
                terminationError(
                  request,
                  started,
                  stdout,
                  stderr,
                  timedOut,
                  truncated,
                ),
              ),
            ),
          TERMINATION_GRACE_MS * 2,
        );
        forceKillTimer.unref();
        hardStopTimer.unref();
      };
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, request.timeoutMs);
      request.signal?.addEventListener("abort", abort, { once: true });
      child.stdout!.on("data", (data: Buffer) => append(stdout, data));
      child.stderr!.on("data", (data: Buffer) => append(stderr, data));
      child.on("error", (cause) =>
        finish(() =>
          reject(
            new RodsLocalError(
              "PROCESS_FAILED",
              `Failed to start ${request.command}: ${cause.message}`,
              {},
              { cause },
            ),
          ),
        ),
      );
      child.on("close", (exitCode, signal) =>
        finish(() => {
          truncated ||= stdout.finish() || stderr.finish();
          const result = {
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            exitCode,
            signal,
            durationMs: Date.now() - started,
            timedOut,
            outputTruncated: truncated,
          };
          if (timedOut)
            reject(
              new RodsLocalError(
                "PROCESS_TIMEOUT",
                `${request.command} timed out after ${request.timeoutMs}ms`,
                { result },
              ),
            );
          else if (request.signal?.aborted)
            reject(
              new RodsLocalError(
                "PROCESS_FAILED",
                `${request.command} cancelled`,
                { result },
              ),
            );
          else resolve(result);
        }),
      );
      // A child that closes stdin early can surface EPIPE asynchronously. It is
      // expected and must not become an unhandled EventEmitter error.
      child.stdin?.on("error", (cause: NodeJS.ErrnoException) => {
        if (cause.code !== "EPIPE")
          finish(() =>
            reject(
              new RodsLocalError(
                "PROCESS_FAILED",
                `${request.command} stdin failed: ${cause.message}`,
                {},
                { cause },
              ),
            ),
          );
      });
      try {
        if (request.input !== undefined) child.stdin?.end(request.input);
        else child.stdin?.end();
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EPIPE")
          finish(() =>
            reject(
              new RodsLocalError(
                "PROCESS_FAILED",
                `${request.command} stdin failed`,
                {},
                { cause },
              ),
            ),
          );
      }
    });
  }
}

/** Keep only whole UTF-8 code points, never emitting replacement characters from a cut byte sequence. */
/**
 * Buffers a partial UTF-8 sequence across `data` events. Byte accounting is
 * performed only for complete code points, so a cap cannot cut a character.
 */
class Utf8OutputCollector {
  private chunks: Buffer[] = [];
  private pending = Buffer.alloc(0);
  truncated = false;

  append(input: Buffer, available: number): number {
    const combined = this.pending.length
      ? Buffer.concat([this.pending, input])
      : input;
    this.pending = Buffer.alloc(0);
    let index = 0;
    let captured = 0;
    while (index < combined.length) {
      const sequence = validUtf8Sequence(combined, index);
      if (sequence === "incomplete") {
        this.pending = Buffer.from(combined.subarray(index));
        break;
      }
      if (sequence === 0) {
        // Drop malformed bytes instead of Buffer#toString replacing them with
        // U+FFFD. This makes output deterministic and never exceeds the cap.
        this.truncated = true;
        index++;
        continue;
      }
      if (captured + sequence > available) {
        this.truncated = true;
        break;
      }
      this.chunks.push(combined.subarray(index, index + sequence));
      captured += sequence;
      index += sequence;
    }
    return captured;
  }

  discard(_input: Buffer): void {
    this.truncated = true;
  }
  finish(): boolean {
    const hadPartial = this.pending.length > 0;
    this.pending = Buffer.alloc(0);
    return hadPartial;
  }
  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function utf8Width(byte: number): number {
  return byte < 0x80
    ? 1
    : byte >= 0xf0 && byte <= 0xf4
      ? 4
      : byte >= 0xe0 && byte <= 0xef
        ? 3
        : byte >= 0xc2 && byte <= 0xdf
          ? 2
          : 0;
}
function isContinuation(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xbf;
}
/** Returns a valid sequence width, 0 for malformed bytes, or incomplete. */
function validUtf8Sequence(
  input: Buffer,
  index: number,
): number | "incomplete" {
  const first = input[index]!;
  const width = utf8Width(first);
  if (width === 0) return 0;
  if (width === 1) return 1;
  if (index + width > input.length) {
    // A malformed prefix is discarded now; only a plausible split character
    // is retained for the next stream event.
    return [...input.subarray(index + 1)].every(isContinuation)
      ? "incomplete"
      : 0;
  }
  const second = input[index + 1]!;
  if (
    !isContinuation(second) ||
    (width > 2 && !isContinuation(input[index + 2]!)) ||
    (width > 3 && !isContinuation(input[index + 3]!))
  )
    return 0;
  if (
    (first === 0xe0 && second < 0xa0) ||
    (first === 0xed && second > 0x9f) ||
    (first === 0xf0 && second < 0x90) ||
    (first === 0xf4 && second > 0x8f)
  )
    return 0;
  return width;
}

function terminationError(
  request: ProcessRequest,
  started: number,
  stdout: Utf8OutputCollector,
  stderr: Utf8OutputCollector,
  timedOut: boolean,
  outputTruncated: boolean,
): RodsLocalError {
  outputTruncated ||= stdout.finish() || stderr.finish();
  const result = {
    stdout: stdout.toString(),
    stderr: stderr.toString(),
    exitCode: null,
    signal: null,
    durationMs: Date.now() - started,
    timedOut,
    outputTruncated,
  };
  return timedOut
    ? new RodsLocalError(
        "PROCESS_TIMEOUT",
        `${request.command} timed out after ${request.timeoutMs}ms`,
        { result },
      )
    : new RodsLocalError("PROCESS_FAILED", `${request.command} cancelled`, {
        result,
      });
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    /* process already exited */
  }
}
