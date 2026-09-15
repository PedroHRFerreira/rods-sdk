import type {
  EffectiveRouteProof,
  HarnessConfigurationProof,
  HarnessRouteProof,
  LocalityProof,
  NetworkConfinementProof,
  NetworkIsolationProof,
  RouteEvidence,
  RuntimeLocalityProof,
} from "./types.js";

export type EffectiveRouteInput = {
  runtime: RuntimeLocalityProof;
  configuration?: HarnessConfigurationProof;
  attestation?: HarnessRouteProof;
  confinement?: NetworkConfinementProof;
  verifiedAt?: string;
};

/** Converts the established runtime contract without treating it as harness evidence. */
export function runtimeLocalityFromProof(
  proof: LocalityProof,
): RuntimeLocalityProof {
  const sameMachine = proof.loopback && proof.runtimeVerified;
  return {
    runtime: proof.runtime,
    endpoint: proof.endpoint,
    model: proof.model ?? "",
    endpointLoopback: proof.loopback,
    runtimeVerified: proof.runtimeVerified,
    modelVerified: proof.modelVerified && Boolean(proof.model),
    executionLocality: sameMachine ? "same-machine" : "unknown",
    localityVerified:
      sameMachine && proof.modelVerified && Boolean(proof.model),
    evidence: proof.evidence,
  };
}

/** Compatibility bridge until every platform has a real confinement implementation. */
export function confinementFromIsolation(
  proof: NetworkIsolationProof,
): NetworkConfinementProof {
  return {
    supported: proof.supported,
    enabled: proof.enabled,
    mechanism: proof.mechanism ?? "unavailable",
    loopbackAllowed: proof.loopbackAllowed,
    externalNetworkBlocked: proof.externalNetworkBlocked,
    allowedEndpoints: [],
    externalConnectionsSucceeded: Number.POSITIVE_INFINITY,
    evidence: [],
  };
}

export function isHarnessConfigurationVerified(
  proof: HarnessConfigurationProof | undefined,
): proof is HarnessConfigurationProof & {
  provider: string;
  model: string;
  configuredEndpoint: string;
  providerAllowlist: string[];
} {
  return Boolean(
    proof &&
    proof.provider &&
    proof.model &&
    proof.configuredEndpoint &&
    proof.providerAllowlist?.includes(proof.provider) &&
    proof.providerExplicit &&
    proof.modelExplicit &&
    proof.endpointExplicit &&
    proof.allowlistEnforced,
  );
}

export function isNetworkConfined(
  proof: NetworkConfinementProof | undefined,
  runtimeEndpoint?: string,
): proof is NetworkConfinementProof {
  return Boolean(
    proof &&
    proof.supported &&
    proof.enabled &&
    proof.externalNetworkBlocked &&
    proof.loopbackAllowed &&
    proof.externalConnectionsSucceeded === 0 &&
    runtimeEndpoint &&
    proof.allowedEndpoints.length > 0 &&
    proof.allowedEndpoints.every((allowed) =>
      sameEndpoint(allowed, runtimeEndpoint),
    ),
  );
}

/**
 * Builds a route proof from two independent strategies. Configuration alone
 * can never make this proof verified.
 */
export function buildEffectiveRouteProof(
  input: EffectiveRouteInput,
): EffectiveRouteProof {
  const { runtime, configuration, attestation, confinement } = input;
  const configurationVerified = isHarnessConfigurationVerified(configuration);
  const confined = isNetworkConfined(confinement, runtime.endpoint);
  const attested = Boolean(
    attestation?.routeVerified &&
    attestation.provider &&
    attestation.endpoint &&
    attestation.model &&
    attestation.runtime === runtime.runtime &&
    attestation.cloudFallbackEnabled === false &&
    attestation.cloudCredentialsRequired === false &&
    attestation.provider === runtime.runtime &&
    attestation.model === runtime.model &&
    sameEndpoint(attestation.endpoint, runtime.endpoint),
  );
  const configuredForRuntime = Boolean(
    configurationVerified &&
    configuration.provider === runtime.runtime &&
    configuration.model === runtime.model &&
    sameEndpoint(configuration.configuredEndpoint, runtime.endpoint),
  );
  const runtimeVerified =
    runtime.runtimeVerified &&
    runtime.localityVerified &&
    runtime.executionLocality === "same-machine";
  const method = attested ? "harness-attestation" : "network-confinement";
  const verified =
    runtimeVerified &&
    runtime.modelVerified &&
    (attested || (configuredForRuntime && confined));
  const evidence: RouteEvidence[] = [
    ...runtime.evidence,
    ...(configuration?.evidence ?? []),
    ...(attestation?.evidence ?? []),
    ...(confinement?.evidence ?? []),
    {
      source: "effective-route",
      detail: attested
        ? "Harness attestation matches the verified runtime"
        : confined && configuredForRuntime
          ? "Controlled harness configuration is limited to the verified runtime by network confinement"
          : "Effective route remains unverified",
    },
  ];
  return {
    verified,
    method,
    harness: configuration?.harness ?? attestation?.harness ?? "unknown",
    provider: attestation?.provider ?? configuration?.provider ?? "unknown",
    model: attestation?.model ?? configuration?.model ?? "unknown",
    endpoint: attestation?.endpoint ?? configuration?.configuredEndpoint ?? "unknown",
    runtimeVerified,
    modelVerified: runtime.modelVerified,
    executionLocality: runtime.executionLocality,
    externalNetworkPossible: !confined,
    evidence,
    verifiedAt: input.verifiedAt ?? new Date().toISOString(),
  };
}

function sameEndpoint(left: string, right: string): boolean {
  try {
    const a = new URL(normalizeEndpoint(left));
    const b = new URL(normalizeEndpoint(right));
    return a.hostname === b.hostname && effectivePort(a) === effectivePort(b);
  } catch {
    return false;
  }
}

function normalizeEndpoint(value: string): string {
  return value.includes("://") ? value : `http://${value}`;
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}
