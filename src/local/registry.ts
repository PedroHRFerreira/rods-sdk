import type { ExecutionHarness, LocalRuntime } from "./types.js";
import { RodsLocalError } from "./errors.js";

class Registry<T extends { readonly id: string }> {
  private readonly values = new Map<string, T>();
  register(value: T): void {
    if (this.values.has(value.id))
      throw new RodsLocalError(
        "CONFIGURATION_ERROR",
        `Duplicate local integration: ${value.id}`,
      );
    this.values.set(value.id, value);
  }
  get(id: string): T {
    const value = this.values.get(id);
    if (!value)
      throw new RodsLocalError(
        "PROVIDER_NOT_AVAILABLE",
        `Local integration is not registered: ${id}`,
      );
    return value;
  }
  list(): T[] {
    return [...this.values.values()];
  }
}

export class LocalRuntimeRegistry extends Registry<LocalRuntime> {}
export class ExecutionHarnessRegistry extends Registry<ExecutionHarness> {}
