import type {
  CodexLocalProvider,
  ExecutionHarness,
  HarnessDiscovery,
  HarnessRouteProof,
} from "./types.js";

export type CodexVersionProbe = (signal?: AbortSignal) => Promise<string | null>;

/**
 * Codex currently advertises OSS local providers, but exposes no structured
 * query that attests the active provider, endpoint, model, or cloud fallback.
 * This adapter records that boundary without parsing human CLI output or config.
 */
export class CodexHarnessAdapter implements ExecutionHarness {
  readonly id = "codex";
  constructor(private readonly versionProbe: CodexVersionProbe) {}

  async verifyLocalRoute(
    _provider?: CodexLocalProvider,
    signal?: AbortSignal,
  ): Promise<HarnessRouteProof> {
    const version = await this.versionProbe(signal);
    if (!version)
      return {
        harness: "codex",
        routeVerified: false,
        cloudFallbackEnabled: "unknown",
        cloudCredentialsRequired: "unknown",
        evidence: [],
        diagnostics: ["Codex is not installed"],
      };
    return {
      harness: "codex",
      routeVerified: false,
      cloudFallbackEnabled: "unknown",
      cloudCredentialsRequired: "unknown",
      evidence: [
        {
          source: "codex-cli",
          detail: `Codex ${version} is installed; no structured local-route attestation is available`,
        },
      ],
      diagnostics: [
        "HARNESS_ROUTE_UNVERIFIED: Codex does not expose a structured proof of active provider, endpoint, model, or cloud fallback",
      ],
    };
  }

  async discover(signal?: AbortSignal): Promise<HarnessDiscovery> {
    const proof = await this.verifyLocalRoute(undefined, signal);
    return proof.evidence.length
      ? { installed: true, ready: false, diagnostics: proof.diagnostics }
      : { installed: false, ready: false, diagnostics: proof.diagnostics };
  }
}
