import { RodsLocalError } from "./errors.js";

/**
 * Non-negotiable boundary for the local Codex harness. Runtime selection and
 * model configuration deliberately live elsewhere; this contract governs only
 * filesystem/process authority granted to the coding agent.
 */
export interface HarnessSandboxPolicy {
  sandbox: "workspace-write";
  additionalWritableDirectories: readonly [];
  dangerousBypass: false;
  networkAccess: false;
}

export const LOCAL_HARNESS_SANDBOX_POLICY: HarnessSandboxPolicy = Object.freeze(
  {
    sandbox: "workspace-write",
    additionalWritableDirectories: Object.freeze([]) as readonly [],
    dangerousBypass: false,
    networkAccess: false,
  },
);

export interface HarnessCommand {
  command: "codex";
  args: string[];
}

/**
 * Constructs the intentionally small Codex invocation used from an isolated
 * worktree. No --add-dir, dangerous bypass flag, cloud/model settings, or
 * network-enabling config is accepted by this API. Strict config validation
 * makes older Codex installations fail closed rather than silently ignore the
 * required network restriction.
 */
export function buildCodexWorkspaceWriteCommand(
  prompt: string,
  policy: HarnessSandboxPolicy = LOCAL_HARNESS_SANDBOX_POLICY,
): HarnessCommand {
  assertHarnessSandboxPolicy(policy);
  if (!prompt.trim())
    throw new RodsLocalError(
      "CONFIGURATION_ERROR",
      "Harness prompt must be non-empty",
    );
  return {
    command: "codex",
    args: [
      "exec",
      "--strict-config",
      "--config",
      "sandbox_workspace_write.network_access=false",
      "--sandbox",
      "workspace-write",
      prompt,
    ],
  };
}

export function assertHarnessSandboxPolicy(policy: HarnessSandboxPolicy): void {
  if (
    policy.sandbox !== "workspace-write" ||
    policy.additionalWritableDirectories.length !== 0 ||
    policy.dangerousBypass !== false ||
    policy.networkAccess !== false
  ) {
    throw new RodsLocalError(
      "SECURITY_BLOCK",
      "Local harness policy must use workspace-write with no extra directories, bypass, or network access",
    );
  }
}
