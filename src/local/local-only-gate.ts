import type {
  HarnessRouteProof,
  LocalityProof,
  LocalOnlyGateDecision,
  LocalOnlyNetworkPolicy,
  NetworkIsolationProof,
} from "./types.js";

export type LocalOnlyGateInput = {
  localityProof?: LocalityProof;
  harnessProof: HarnessRouteProof;
  networkProof: NetworkIsolationProof;
  networkPolicy: LocalOnlyNetworkPolicy;
};

/** A missing platform-specific mechanism is evidence of no network isolation. */
export const UNSUPPORTED_NETWORK_ISOLATION: NetworkIsolationProof = Object.freeze({
  supported: false,
  enabled: false,
  loopbackAllowed: false,
  externalNetworkBlocked: false,
});

/** The only authority that permits a --local-only execution to begin. */
export function evaluateLocalOnlyGate(input: LocalOnlyGateInput): LocalOnlyGateDecision {
  const locality = input.localityProof;
  if (!locality || !locality.loopback || !locality.runtimeVerified)
    return {
      allowed: false,
      errorCode: "LOCALITY_NOT_VERIFIED",
      reasons: ["A verified loopback local runtime is required"],
    };
  if (!locality.modelVerified)
    return {
      allowed: false,
      errorCode: "LOCAL_MODEL_NOT_AVAILABLE",
      reasons: ["A verified local model is required"],
    };
  if (
    !input.harnessProof.routeVerified ||
    input.harnessProof.cloudFallbackEnabled !== false ||
    input.harnessProof.cloudCredentialsRequired !== false
  )
    return {
      allowed: false,
      errorCode: "HARNESS_NOT_READY",
      reasons: [
        "Codex provider, endpoint, model, and no-cloud route must be verified",
        ...input.harnessProof.diagnostics,
      ],
    };
  if (
    input.networkPolicy === "require-isolation" &&
    (!input.networkProof.supported ||
      !input.networkProof.enabled ||
      !input.networkProof.loopbackAllowed ||
      !input.networkProof.externalNetworkBlocked)
  )
    return {
      allowed: false,
      errorCode: "NETWORK_ISOLATION_UNAVAILABLE",
      reasons: ["The Local-Only policy requires verified external-network blocking"],
    };
  return { allowed: true, reasons: [] };
}
