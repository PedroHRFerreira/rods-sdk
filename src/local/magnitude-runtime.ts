import {
  assertLocalRuntimeDiscovery,
  type LocalRuntime,
  type LocalRuntimeDiscovery,
} from "./types.js";

/**
 * Magnitude is only an inference runtime. Its CLI protocol is deliberately not
 * encoded here: callers inject a version-verified probe for the installed build.
 */
export type MagnitudeProbe = (
  signal?: AbortSignal,
) => Promise<LocalRuntimeDiscovery>;

export class MagnitudeRuntime implements LocalRuntime {
  readonly id = "magnitude";
  constructor(private readonly probe: MagnitudeProbe) {}
  async discover(signal?: AbortSignal): Promise<LocalRuntimeDiscovery> {
    const discovery = await this.probe(signal);
    assertLocalRuntimeDiscovery(discovery);
    return discovery;
  }
}
