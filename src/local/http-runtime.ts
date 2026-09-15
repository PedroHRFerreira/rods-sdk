import type {
  LocalRuntimeAdapter,
  LocalRuntimeDiscovery,
  LocalityProof,
  RuntimeVerification,
} from "./types.js";

export type JsonResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};
export type JsonGet = (url: string, signal?: AbortSignal) => Promise<JsonResponse>;

export function defaultJsonGet(url: string, signal?: AbortSignal): Promise<JsonResponse> {
  const timeout = AbortSignal.timeout(3_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return fetch(url, { method: "GET", signal: requestSignal }).then((response) => ({
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
  }));
}

export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

/** Shared fail-closed base for adapters backed by documented local HTTP APIs. */
export abstract class LoopbackHttpRuntime implements LocalRuntimeAdapter {
  abstract readonly id: string;
  protected abstract readonly endpoint: string;
  constructor(protected readonly getJson: JsonGet = defaultJsonGet) {}

  protected proof(modelNames: string[], evidence: LocalityProof["evidence"]): LocalityProof {
    return {
      runtime: this.id,
      endpoint: this.endpoint,
      loopback: true,
      model: modelNames[0],
      runtimeVerified: true,
      modelVerified: modelNames.length > 0,
      verifiedAt: new Date().toISOString(),
      evidence,
    };
  }

  abstract verify(signal?: AbortSignal): Promise<RuntimeVerification>;

  async discover(signal?: AbortSignal): Promise<LocalRuntimeDiscovery> {
    const verification = await this.verify(signal);
    if (!verification.reachable) {
      return {
        installed: false,
        ready: false,
        capabilities: [],
        diagnostics: verification.diagnostics,
      };
    }
    if (
      verification.locality !== "verified-local" ||
      !verification.proof?.modelVerified
    ) {
      return {
        installed: true,
        ready: false,
        capabilities: [],
        diagnostics: verification.diagnostics,
      };
    }
    return {
      installed: true,
      ready: true,
      capabilities: [],
      diagnostics: verification.diagnostics,
    };
  }
}
