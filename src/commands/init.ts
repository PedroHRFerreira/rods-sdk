import path from 'node:path';
import type { Command } from 'commander';
import { initProject } from '../services/scaffold.js';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .argument('[path]', 'project root path', '.')
    .option('--force', 'overwrite existing generated files')
    .description('Scaffold rods-sdk governance files for a project')
    .action(async (targetPath: string, options: { force?: boolean }) => {
      const root = path.resolve(targetPath);
      const results = await initProject(root, { force: options.force });

      for (const result of results) {
        console.log(`file=${result.path} status=${result.status}`);
      }
    });
}
