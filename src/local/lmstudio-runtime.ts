import {
  LoopbackHttpRuntime,
  isLoopbackEndpoint,
  type JsonGet,
} from "./http-runtime.js";
import type { RuntimeVerification } from "./types.js";

type LMStudioModels = {
  models?: Array<{
    key?: unknown;
    type?: unknown;
    loaded_instances?: unknown[];
  }>;
};

/**
 * Discovers LM Studio through its native local API.  It is intentionally not a
 * verified-local runtime: LM Link can serve a remote model via localhost.
 */
export class LMStudioRuntimeAdapter extends LoopbackHttpRuntime {
  readonly id = "lmstudio";
  protected readonly endpoint: string;
  constructor(options: { endpoint?: string; getJson?: JsonGet } = {}) {
    super(options.getJson);
    this.endpoint = options.endpoint ?? "http://127.0.0.1:1234/api/v1/models";
  }

  async verify(signal?: AbortSignal): Promise<RuntimeVerification> {
    if (!isLoopbackEndpoint(this.endpoint))
      return {
        reachable: false,
        locality: "remote",
        modelNames: [],
        diagnostics: ["LM Studio endpoint is not a loopback address"],
      };
    try {
      const response = await this.getJson(this.endpoint, signal);
      if (!response.ok)
        return {
          reachable: true,
          locality: "unverified",
          modelNames: [],
          diagnostics: [`LM Studio /api/v1/models returned HTTP ${response.status}`],
        };
      const payload = (await response.json()) as LMStudioModels;
      const modelNames = Array.isArray(payload.models)
        ? payload.models.flatMap((model) =>
            typeof model.key === "string" &&
            model.key &&
            model.type === "llm" &&
            Array.isArray(model.loaded_instances) &&
            model.loaded_instances.length > 0
              ? [model.key]
              : [],
          )
        : [];
      return {
        reachable: true,
        locality: "unverified",
        modelNames,
        diagnostics: [
          "LM Studio locality is unverified: LM Link can serve a remote model through localhost",
          ...(modelNames.length ? [] : ["LM Studio has no loaded LLM model"]),
        ],
      };
    } catch {
      return {
        reachable: false,
        locality: "unverified",
        modelNames: [],
        diagnostics: ["LM Studio loopback API is not reachable"],
      };
    }
  }
}
