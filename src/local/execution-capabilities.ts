import { isHarnessConfigurationVerified } from "./effective-route.js";
import type {
  EffectiveRouteProof,
  HarnessConfigurationProof,
  HarnessRouteProof,
  LocalExecutionCapabilities,
  LocalityProof,
  NetworkConfinementCapability,
} from "./types.js";

export type LocalExecutionCapabilityInput = {
  platform: NodeJS.Platform;
  runtimeProof?: LocalityProof;
  harnessRoute?: HarnessRouteProof;
  harnessConfiguration?: HarnessConfigurationProof;
  effectiveRoute?: EffectiveRouteProof;
  confinement: NetworkConfinementCapability;
};

/**
 * Reports the two deliberately different product capabilities. This function
 * never upgrades a healthy local runtime into a strict Local-Only guarantee.
 */
export function evaluateLocalExecutionCapabilities(
  input: LocalExecutionCapabilityInput,
): LocalExecutionCapabilities {
  const runtimeReady = Boolean(
    input.runtimeProof?.runtimeVerified &&
      input.runtimeProof.loopback &&
      input.runtimeProof.modelVerified &&
      input.runtimeProof.model,
  );
  const harnessEligible = Boolean(
    input.harnessRoute?.routeVerified ||
      isHarnessConfigurationVerified(input.harnessConfiguration),
  );
  const confinementReady =
    input.confinement.supported &&
    input.confinement.installed &&
    input.confinement.usable &&
    input.confinement.verified;
  const effectiveRouteVerified = Boolean(input.effectiveRoute?.verified);
  const reasons: string[] = [];

  if (!runtimeReady)
    reasons.push("LOCAL_RUNTIME_NOT_READY: a verified same-machine model is required");
  if (!harnessEligible)
    reasons.push("HARNESS_NOT_READY: no eligible local harness proof is available");
  if (!confinementReady)
    reasons.push(
      input.platform === "linux"
        ? "NETWORK_ISOLATION_UNAVAILABLE: the Linux confinement backend is not verified"
        : "NETWORK_ISOLATION_UNAVAILABLE: strict confinement is not supported on this platform",
    );
  if (!effectiveRouteVerified)
    reasons.push("EFFECTIVE_ROUTE_NOT_VERIFIED: no verified effective local route is available");

  const strictLocalOnly =
    input.platform !== "linux"
      ? "unsupported"
      : runtimeReady && harnessEligible && confinementReady && effectiveRouteVerified
        ? "available"
        : "unavailable";
  return {
    localExecution: runtimeReady ? "available" : "unavailable",
    strictLocalOnly,
    confinement: {
      backend: input.confinement.backend,
      installed: input.confinement.installed,
      usable: input.confinement.usable,
      verified: input.confinement.verified,
    },
    reasons,
  };
}
