import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { doctorAdapters, syncAdapters } from '../services/adapters.js';
import { initProject, pathExists } from '../services/scaffold.js';
import { runInitWizard } from '../services/skill-planner.js';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .argument('[path]', 'project root path', '.')
    .option('--force', 'overwrite existing generated files')
    .option('--no-plan', 'use deterministic scaffolding without the interactive planner')
    .description('Scaffold rods-sdk governance files for a project')
    .action(async (targetPath: string, options: { force?: boolean; plan?: boolean }) => {
      const root = path.resolve(targetPath);
      if (options.plan !== false && process.stdin.isTTY && process.stdout.isTTY) {
        const terminal = createInterface({ input: process.stdin, output: process.stdout });
        let planned;
        try { planned = await runInitWizard(root, { ask: (question) => terminal.question(question), write: (message) => console.log(message) }, { force: options.force }); }
        finally { terminal.close(); }
        if (planned.status === 'cancelled') { console.log('init=status=cancelled'); return; }
        if (planned.status === 'applied') {
          for (const file of planned.files) console.log(`file=${file.path} status=${file.status}`);
          const buildWarning = await getMissingBuildWarning();
          if (buildWarning) console.warn(buildWarning);
          const reports = await doctorAdapters(root, { target: 'codex' });
          for (const report of reports) console.log(`target=codex adapter=${report.name} enabled=${report.enabled} installed=${report.installed} hooks=${report.hooksDetected}`);
          if (reports.some((report) => report.enabled && !report.installed)) process.exitCode = 1;
          console.log('init=status=completed skills=planned');
          return;
        }
        console.log('planner=unavailable fallback=deterministic');
      }
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
