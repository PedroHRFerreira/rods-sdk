import type { RoutingDecision } from "./types.js";
import { RodsLocalError } from "./errors.js";

/**
 * The sole boundary used by local-only execution. Cloud resolution is not a
 * fallback here; its resolver is intentionally not accepted by this API.
 */
export interface LocalOnlyRouteDependencies {
  resolveLocal(): RoutingDecision;
  /** Present only so tests/integrators can prove it is never resolved. */
  cloudRegistry?: { resolve(): unknown };
}

export function resolveLocalOnlyRoute(
  dependencies: LocalOnlyRouteDependencies,
): RoutingDecision {
  const decision = dependencies.resolveLocal();
  if (decision.cloudCalls !== 0)
    throw new RodsLocalError(
      "CONFIGURATION_ERROR",
      "localOnly routing must report zero cloud calls",
    );
  return decision;
}
