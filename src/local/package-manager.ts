import fs from "node:fs";
import path from "node:path";
import { RodsLocalError } from "./errors.js";

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";
const LOCKFILES: Array<[PackageManager, string[]]> = [
  ["pnpm", ["pnpm-lock.yaml"]],
  ["yarn", ["yarn.lock"]],
  ["bun", ["bun.lock", "bun.lockb"]],
  ["npm", ["package-lock.json"]],
];

export function detectPackageManager(root: string): PackageManager | null {
  const found = LOCKFILES.filter(([, files]) =>
    files.some((file) => fs.existsSync(path.join(root, file))),
  ).map(([manager]) => manager);
  if (found.length <= 1) return found[0] ?? null;
  throw new RodsLocalError(
    "CONFIGURATION_ERROR",
    `Ambiguous package-manager lockfiles: ${found.join(", ")}`,
    { managers: found },
  );
}
