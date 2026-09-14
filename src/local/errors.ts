export const LOCAL_ERROR_CODES = [
  "CONTEXT_NOT_READY",
  "PROVIDER_NOT_AVAILABLE",
  "LOCAL_RUNTIME_NOT_READY",
  "RUNTIME_CONTRACT_UNSUPPORTED",
  "HARNESS_NOT_READY",
  "MODEL_NOT_AVAILABLE",
  "LOCAL_CAPABILITY_INSUFFICIENT",
  "PROCESS_TIMEOUT",
  "PROCESS_FAILED",
  "VALIDATION_FAILED",
  "LOCAL_EXECUTION_FAILED",
  "SECURITY_BLOCK",
  "CONFIGURATION_ERROR",
  "FEATURE_NOT_AVAILABLE",
] as const;
export type LocalErrorCode = (typeof LOCAL_ERROR_CODES)[number];

export class RodsLocalError extends Error {
  constructor(
    readonly code: LocalErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RodsLocalError";
  }
}

export function isRodsLocalError(
  error: unknown,
  code?: LocalErrorCode,
): error is RodsLocalError {
  return error instanceof RodsLocalError && (!code || error.code === code);
}
