import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { doctorAdapters, syncAdapters } from '../services/adapters.js';
import { initProject, pathExists } from '../services/scaffold.js';

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

      const buildWarning = await getMissingBuildWarning();

      if (buildWarning) {
        console.warn(buildWarning);
      }

      const syncResult = await syncAdapters(root, 'codex', { force: options.force });
      console.log(`target=${syncResult.target} files=${syncResult.files.length}`);

      for (const file of syncResult.files) {
        console.log(`file=${file.path} status=${file.status}`);
      }

      const reports = await doctorAdapters(root, { target: 'codex' });
      const failed = reports.filter((report) => report.enabled && !report.installed);

      for (const report of reports) {
        console.log(
          `target=codex adapter=${report.name} enabled=${report.enabled} installed=${report.installed} hooks=${report.hooksDetected}`
        );
      }

      if (failed.length > 0) {
        process.exitCode = 1;
      }
    });
}

export async function getMissingBuildWarning(
  env: NodeJS.ProcessEnv = process.env,
  packageRoot = fileURLToPath(new URL('../..', import.meta.url))
): Promise<string | null> {
  const userAgent = env.npm_config_user_agent ?? '';

  if (!userAgent.includes('pnpm')) {
    return null;
  }

  const hasDist = await pathExists(path.join(packageRoot, 'dist'));

  if (hasDist) {
    return null;
  }

  return [
    'warning=rods-sdk dist/ was not generated. pnpm may have blocked lifecycle scripts.',
    'Run `pnpm approve-builds` or add `rods-sdk` to `pnpm.onlyBuiltDependencies` in the root package.json.'
  ].join(' ');
}
