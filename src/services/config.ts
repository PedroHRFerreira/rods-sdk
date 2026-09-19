import fs from 'node:fs';
import path from 'node:path';
import type { IContextConfig } from '../types/context.js';
import { ensureDir, getConfigPath } from '../utils/paths.js';

export function getDefaultConfig(): IContextConfig {
  return {
    database: '~/.context-engine/db/context.db',
    chunkSize: 120,
    searchLimit: 8,
    watch: true,
    ignore: ['node_modules', '.git', '.nuxt', '.output', 'dist', 'coverage', '.cache', '.next', 'build', 'tmp', '.turbo']
  };
}

export function loadConfig(baseDir = process.cwd()): IContextConfig {
  const configPath = getConfigPath(baseDir);
  ensureDir(path.dirname(configPath));

  if (!fs.existsSync(configPath)) {
    const defaultConfig = getDefaultConfig();
    fs.writeFileSync(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`);
    return defaultConfig;
  }

  const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<IContextConfig>;

  return {
    ...getDefaultConfig(),
    ...parsedConfig,
    ignore: parsedConfig.ignore ?? getDefaultConfig().ignore
  };
}
