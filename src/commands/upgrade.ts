import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Command } from 'commander';
import { ContextDatabase } from '../database/database.js';
import { doctorAdapters, listAdapterTargets, loadGovernanceConfig, syncAdapters } from '../services/adapters.js';
import { loadConfig } from '../services/config.js';
import { upgradeProject } from '../services/scaffold.js';

export function registerUpgradeCommand(program: Command): void {
  program
    .command('upgrade')
    .argument('[path]', 'project root path', '.')
    .option('--force', 'overwrite generated files even when customized')
    .option('--dry-run', 'show planned changes without writing files')
    .description('Upgrade rods-sdk governance files and Context Engine schema')
    .action(async (targetPath: string, options: { force?: boolean; dryRun?: boolean }) => {
      const root = path.resolve(targetPath);

      if (options.dryRun) {
        console.log('package=rods-sdk status=would-update');
      } else {
        const update = await updateInstalledPackage(root);
        console.log(`package=rods-sdk status=${update.ok ? 'updated' : 'skipped'} message="${update.message}"`);
      }

      migrateContextDatabase();

      const results = await upgradeProject(root, {
        force: options.force,
        dryRun: options.dryRun
      });

      for (const result of results) {
        console.log(`file=${result.path} status=${result.status}`);

        if (result.upstreamChanged) {
          console.log(`customized_with_newer_upstream=${result.path}`);
        }
      }

      const config = await loadGovernanceConfig(root);
      const targets = listAdapterTargets()
        .map((target) => target.id)
        .filter((target) => config.targets[target]?.enabled);

      for (const target of targets) {
        if (options.dryRun) {
          console.log(`target=${target} status=would-sync`);
          continue;
        }

        const syncResult = await syncAdapters(root, target, { force: options.force });
        console.log(`target=${syncResult.target} files=${syncResult.files.length}`);

        for (const file of syncResult.files) {
          console.log(`file=${file.path} status=${file.status}`);
        }

        const reports = await doctorAdapters(root, { target });
        const failed = reports.filter((report) => report.enabled && !report.installed);

        if (failed.length > 0) {
          process.exitCode = 1;
        }
      }
    });
}

function migrateContextDatabase(): void {
  const db = new ContextDatabase(loadConfig());
  db.close();
  console.log('context_database=migrated');
}

function updateInstalledPackage(root: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['update', 'rods-sdk'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      resolve({ ok: false, message: error.message });
    });
    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        message: code === 0 ? 'npm update rods-sdk' : firstLine(stderr) ?? `npm exited with ${code}`
      });
    });
  });
}

function firstLine(input: string): string | undefined {
  const trimmed = input.trim();

  return trimmed ? trimmed.split(/\r?\n/, 1)[0] : undefined;
}
