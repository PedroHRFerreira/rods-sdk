import type {
  EffectiveRouteProof,
  HarnessConfigurationProof,
  HarnessRouteProof,
  LocalityProof,
  LocalOnlyGateDecision,
  LocalOnlyNetworkPolicy,
  LocalOnlyPolicy,
  NetworkConfinementProof,
  NetworkIsolationProof,
  RuntimeLocalityProof,
} from "./types.js";
import { isHarnessConfigurationVerified } from "./effective-route.js";

export type LegacyLocalOnlyGateInput = {
  localityProof?: LocalityProof;
  harnessProof: HarnessRouteProof;
  networkProof: NetworkIsolationProof;
  networkPolicy: LocalOnlyNetworkPolicy;
};

export type EffectiveLocalOnlyGateInput = {
  runtimeProof: RuntimeLocalityProof;
  harnessConfigurationProof?: HarnessConfigurationProof;
  effectiveRouteProof: EffectiveRouteProof;
  confinementProof: NetworkConfinementProof;
  policy: LocalOnlyPolicy;
};

export type LocalOnlyGateInput =
  | LegacyLocalOnlyGateInput
  | EffectiveLocalOnlyGateInput;

export const DEFAULT_LOCAL_ONLY_POLICY: LocalOnlyPolicy = Object.freeze({
  requireSameMachineInference: true,
  requireVerifiedRuntime: true,
  requireVerifiedModel: true,
  requireEffectiveRouteProof: true,
  requireExternalNetworkBlocked: true,
  allowLocalNetworkRuntime: false,
});

/** A missing platform-specific mechanism is evidence of no network isolation. */
export const UNSUPPORTED_NETWORK_ISOLATION: NetworkIsolationProof =
  Object.freeze({
    supported: false,
    enabled: false,
    loopbackAllowed: false,
    externalNetworkBlocked: false,
  });

/** The only authority that permits a --local-only execution to begin. */
export function evaluateLocalOnlyGate(
  input: LocalOnlyGateInput,
): LocalOnlyGateDecision {
  if ("effectiveRouteProof" in input)
    return evaluateEffectiveLocalOnlyGate(input);
  return evaluateLegacyLocalOnlyGate(input);
}

function evaluateLegacyLocalOnlyGate(
  input: LegacyLocalOnlyGateInput,
): LocalOnlyGateDecision {
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
      reasons: [
        "The Local-Only policy requires verified external-network blocking",
      ],
    };
  return { allowed: true, reasons: [] };
}

/**
 * The definitive Local-Only policy path. A verified configuration is only
 * sufficient when it is combined with a same-machine runtime and enforced
 * network confinement, or when a harness supplies full route attestation.
 */
function evaluateEffectiveLocalOnlyGate(
  input: EffectiveLocalOnlyGateInput,
): LocalOnlyGateDecision {
  const {
    runtimeProof: runtime,
    confinementProof: confinement,
    policy,
    effectiveRouteProof: route,
  } = input;
  if (
    policy.requireVerifiedRuntime &&
    (!runtime.runtimeVerified || !runtime.localityVerified)
  )
    return {
      allowed: false,
      errorCode: "LOCALITY_NOT_VERIFIED",
      reasons: ["A verified local runtime is required"],
    };
  if (policy.requireVerifiedModel && !runtime.modelVerified)
    return {
      allowed: false,
      errorCode: "LOCAL_MODEL_NOT_AVAILABLE",
      reasons: ["A verified local model is required"],
    };
  if (
    policy.requireSameMachineInference &&
    runtime.executionLocality !== "same-machine" &&
    !(
      policy.allowLocalNetworkRuntime &&
      runtime.executionLocality === "local-network"
    )
  )
    return {
      allowed: false,
      errorCode: "LOCALITY_NOT_VERIFIED",
      reasons: ["The Local-Only policy requires same-machine inference"],
    };
  if (
    route.method === "network-confinement" &&
    !isHarnessConfigurationVerified(input.harnessConfigurationProof)
  )
    return {
      allowed: false,
      errorCode: "HARNESS_CONFIGURATION_NOT_VERIFIED",
      reasons: [
        "Network-confinement routing requires an explicit provider, model, endpoint, and enforced allowlist",
      ],
    };
  if (policy.requireExternalNetworkBlocked) {
    if (!confinement.supported)
      return {
        allowed: false,
        errorCode: "NETWORK_ISOLATION_UNAVAILABLE",
        reasons: ["The platform cannot enforce external-network blocking"],
      };
    if (confinement.externalConnectionsSucceeded > 0)
      return {
        allowed: false,
        errorCode: "EXTERNAL_NETWORK_REACHABLE",
        reasons: [
          "An external connection succeeded during Local-Only execution",
        ],
      };
    if (
      !confinement.enabled ||
      !confinement.externalNetworkBlocked ||
      !confinement.loopbackAllowed
    )
      return {
        allowed: false,
        errorCode: "NETWORK_ISOLATION_FAILED",
        reasons: [
          "External-network blocking and loopback access must both be enforced",
        ],
      };
  }
  if (policy.requireEffectiveRouteProof && !route.verified)
    return {
      allowed: false,
      errorCode: "EFFECTIVE_ROUTE_NOT_VERIFIED",
      reasons: [
        "Neither harness attestation nor confined local routing proved the effective route",
      ],
    };
  if (policy.requireExternalNetworkBlocked && route.externalNetworkPossible)
    return {
      allowed: false,
      errorCode: "EFFECTIVE_ROUTE_NOT_VERIFIED",
      reasons: ["The effective route still permits external-network access"],
    };
  return { allowed: true, reasons: [] };
}
