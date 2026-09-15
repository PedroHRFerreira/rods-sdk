import fs from "node:fs/promises";
import os from "node:os";

export interface MachineProfile {
  os: { platform: NodeJS.Platform; release: string };
  cpu: { model?: string; cores: number; architecture: string };
  memory: { totalMb: number; availableMb: number };
  gpu?: {
    vendor: string;
    model: string;
    vramMb: number;
    backend: "cuda" | "rocm" | "metal" | "other";
  };
  disk: { availableMb: number };
}

function mb(bytes: number): number {
  return Math.max(0, Math.floor(bytes / (1024 * 1024)));
}

async function availableMemory(): Promise<number> {
  if (process.platform !== "linux") return os.freemem();
  try {
    const meminfo = await fs.readFile("/proc/meminfo", "utf8");
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo);
    return match ? Number(match[1]) * 1024 : os.freemem();
  } catch {
    return os.freemem();
  }
}

/** Read-only, dependency-free inventory; GPU probing is deliberately deferred. */
export async function collectMachineProfile(root: string): Promise<MachineProfile> {
  const [available, stats] = await Promise.all([
    availableMemory(),
    fs.statfs(root).catch(() => null),
  ]);
  const cpu = os.cpus();
  return {
    os: { platform: process.platform, release: os.release() },
    cpu: {
      model: cpu[0]?.model,
      cores: os.availableParallelism(),
      architecture: process.arch,
    },
    memory: { totalMb: mb(os.totalmem()), availableMb: mb(available) },
    disk: { availableMb: stats ? mb(stats.bavail * stats.bsize) : 0 },
  };
}
