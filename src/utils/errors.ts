import { RodsLocalError } from "../local/errors.js";

export function formatCliError(
  error: unknown,
  debug = process.env.RODS_DEBUG,
): string {
  if (!(error instanceof Error)) return String(error);
  return debug === "1" ? (error.stack ?? error.message) : error.message;
}

/** Stable, non-secret command-line error contract for Local-First commands. */
export function localCliError(error: unknown): {
  code: string;
  message: string;
  exitCode: number;
} {
  if (error instanceof RodsLocalError) {
    const message = error.message
      .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
      .replace(
        /((?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*["']?)[^\s,"']+/gi,
        "$1[REDACTED]",
      );
    const exitCode =
      error.code === "CONFIGURATION_ERROR" ||
      error.code === "CONTEXT_NOT_READY" ||
      error.code === "LOCAL_RUNTIME_NOT_READY" ||
      error.code === "HARNESS_NOT_READY" ||
      error.code === "MODEL_NOT_AVAILABLE" ||
      error.code === "LOCAL_CAPABILITY_INSUFFICIENT"
        ? 2
        : error.code === "FEATURE_NOT_AVAILABLE"
          ? 3
          : 1;
    return { code: error.code, message, exitCode };
  }
  return {
    code: "LOCAL_EXECUTION_FAILED",
    message: "Local execution failed",
    exitCode: 1,
  };
}
