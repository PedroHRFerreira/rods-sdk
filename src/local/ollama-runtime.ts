import {
  LoopbackHttpRuntime,
  isLoopbackEndpoint,
  type JsonGet,
} from "./http-runtime.js";
import type { RuntimeVerification } from "./types.js";

type OllamaTags = { models?: Array<{ name?: unknown }> };

/** Verifies Ollama through its documented local `/api/tags` endpoint. */
export class OllamaRuntimeAdapter extends LoopbackHttpRuntime {
  readonly id = "ollama";
  protected readonly endpoint: string;
  constructor(options: { endpoint?: string; getJson?: JsonGet } = {}) {
    super(options.getJson);
    this.endpoint = options.endpoint ?? "http://127.0.0.1:11434/api/tags";
  }

  async verify(signal?: AbortSignal): Promise<RuntimeVerification> {
    if (!isLoopbackEndpoint(this.endpoint))
      return {
        reachable: false,
        locality: "remote",
        modelNames: [],
        diagnostics: ["Ollama endpoint is not a loopback address"],
      };
    try {
      const response = await this.getJson(this.endpoint, signal);
      if (!response.ok)
        return {
          reachable: true,
          locality: "unverified",
          modelNames: [],
          diagnostics: [`Ollama /api/tags returned HTTP ${response.status}`],
        };
      const payload = (await response.json()) as OllamaTags;
      const modelNames = Array.isArray(payload.models)
        ? payload.models.flatMap((model) =>
            typeof model.name === "string" && model.name ? [model.name] : [],
          )
        : [];
      return {
        reachable: true,
        locality: "verified-local",
        modelNames,
        proof: this.proof(modelNames, [
          { source: "ollama-api", detail: "GET /api/tags on loopback succeeded" },
        ]),
        diagnostics: modelNames.length ? [] : ["Ollama has no local models installed"],
      };
    } catch {
      return {
        reachable: false,
        locality: "unverified",
        modelNames: [],
        diagnostics: ["Ollama loopback API is not reachable"],
      };
    }
  }
}
