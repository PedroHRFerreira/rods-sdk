/** Shared, provider-neutral contracts for Local-First execution. */
export type TaskComplexity = "simple" | "medium" | "complex";
export type PowerMode = "eco" | "balanced" | "performance" | "max" | "auto";
export type ExecutionStatus = "SUCCESS" | "FAILURE";
export type ValidationStatus = "VALIDATED" | "UNVALIDATED" | "FAILED";
export type DecisionEventName =
  | "CONTEXT_SELECTED"
  | "TASK_CLASSIFIED"
  | "LOCAL_CAPABILITY_DETECTED"
  | "PROVIDER_SELECTED"
  | "WORKTREE_CREATED"
  | "EXECUTION_STARTED"
  | "VALIDATION_STARTED"
  | "VALIDATION_COMPLETED"
  | "PATCH_GENERATED"
  | "EXECUTION_COMPLETED"
  | "VALIDATION_FAILED"
  | "EXECUTION_FAILED";

export interface ContextBudget {
  maxTokens: number;
  maxChunks: number;
  maxFiles: number;
}
export interface LocalCapability {
  id: string;
  label: string;
  contextWindow?: number;
  tiers: TaskComplexity[];
  powerModes: Exclude<PowerMode, "auto">[];
}
export interface DecisionTrace {
  event: DecisionEventName;
  at: string;
  details?: Record<string, unknown>;
}
export interface RoutingDecision {
  runtimeId: string;
  harnessId: string;
  capability: LocalCapability;
  powerMode: PowerMode;
  reason: string[];
  cloudCalls: 0;
}
export type ValidationStep = {
  name: string;
  status: "passed" | "failed" | "skipped";
  reason?: string;
};
export type ValidatedResult = { status: "VALIDATED"; steps: ValidationStep[] };
export type UnvalidatedResult = {
  status: "UNVALIDATED";
  steps: ValidationStep[];
};
export type FailedValidationResult = {
  status: "FAILED";
  steps: ValidationStep[];
};
export type ValidationResult =
  | ValidatedResult
  | UnvalidatedResult
  | FailedValidationResult;

type ExecutionArtifacts = {
  patchPath?: string;
  reportPath?: string;
  trace: DecisionTrace[];
  cloudCalls: 0;
};
/** A successful execution cannot be represented with failed validation. */
export type ExecutionResult =
  | ({
      status: "SUCCESS";
      validation: ValidatedResult | UnvalidatedResult;
    } & ExecutionArtifacts)
  | ({ status: "FAILURE"; validation: ValidationResult } & ExecutionArtifacts);

export function successfulExecution(
  validation: ValidatedResult | UnvalidatedResult,
  artifacts: ExecutionArtifacts,
): ExecutionResult {
  return { status: "SUCCESS", validation, ...artifacts };
}

export function failedExecution(
  validation: ValidationResult,
  artifacts: ExecutionArtifacts,
): ExecutionResult {
  return { status: "FAILURE", validation, ...artifacts };
}

export type LocalRuntimeDiscovery =
  | {
      installed: true;
      ready: true;
      version?: string;
      capabilities: LocalCapability[];
      diagnostics: string[];
    }
  | {
      installed: false;
      ready: false;
      version?: never;
      capabilities: [];
      diagnostics: string[];
    }
  | {
      installed: true;
      ready: false;
      version?: string;
      capabilities: [];
      diagnostics: string[];
    };

export type HarnessDiscovery =
  | { installed: true; ready: true; diagnostics: string[] }
  | { installed: false; ready: false; diagnostics: string[] }
  | { installed: true; ready: false; diagnostics: string[] };

/** Validate untyped adapter output before it crosses into provider-neutral code. */
export function assertLocalRuntimeDiscovery(
  value: unknown,
): asserts value is LocalRuntimeDiscovery {
  if (!value || typeof value !== "object")
    throw new Error("Local runtime discovery must be an object");
  const discovery = value as Record<string, unknown>;
  if (
    typeof discovery.installed !== "boolean" ||
    typeof discovery.ready !== "boolean" ||
    !Array.isArray(discovery.capabilities) ||
    !Array.isArray(discovery.diagnostics)
  )
    throw new Error("Malformed local runtime discovery");
  if (discovery.ready && !discovery.installed)
    throw new Error("A local runtime cannot be ready when not installed");
  if (!discovery.ready && discovery.capabilities.length)
    throw new Error("A non-ready local runtime cannot advertise capabilities");
  if (!discovery.installed && discovery.version !== undefined)
    throw new Error("An uninstalled local runtime cannot advertise a version");
}

export function assertHarnessDiscovery(
  value: unknown,
): asserts value is HarnessDiscovery {
  if (!value || typeof value !== "object")
    throw new Error("Harness discovery must be an object");
  const discovery = value as Record<string, unknown>;
  if (
    typeof discovery.installed !== "boolean" ||
    typeof discovery.ready !== "boolean" ||
    !Array.isArray(discovery.diagnostics)
  )
    throw new Error("Malformed harness discovery");
  if (discovery.ready && !discovery.installed)
    throw new Error("A harness cannot be ready when not installed");
}
export interface LocalRuntime {
  readonly id: string;
  discover(signal?: AbortSignal): Promise<LocalRuntimeDiscovery>;
}
export interface ExecutionHarness {
  readonly id: string;
  discover(signal?: AbortSignal): Promise<HarnessDiscovery>;
}
