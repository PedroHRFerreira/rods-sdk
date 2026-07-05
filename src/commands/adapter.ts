import path from 'node:path';
import type { Command } from 'commander';
import {
  doctorAdapters,
  enableAdapter,
  isAdapterName,
  listAdapters,
  syncAdapters,
  type AdapterTarget
} from '../services/adapters.js';

export function registerAdapterCommand(program: Command): void {
  const adapter = program.command('adapter').description('Manage optional rods-sdk adapters');

  adapter
    .command('list')
    .description('List available adapters')
    .action(() => {
      for (const definition of listAdapters()) {
        console.log(
          `name=${definition.name} phase=${definition.phase} setup="${definition.codexSetup}" description="${definition.description}"`
        );
      }
    });

  adapter
    .command('enable')
    .argument('<name>', 'adapter name')
    .argument('[path]', 'project root path', '.')
    .option('--force', 'overwrite generated adapter note')
    .description('Enable an optional adapter in .ai/config.json')
    .action(async (name: string, targetPath: string, options: { force?: boolean }) => {
      if (!isAdapterName(name)) {
        throw new Error(`Unknown adapter: ${name}`);
      }

      const result = await enableAdapter(path.resolve(targetPath), name, { force: options.force });
      console.log(`adapter=${result.adapter} enabled=true config=${result.configPath}`);

      for (const file of result.files) {
        console.log(`file=${file.path} status=${file.status}`);
      }
    });

  adapter
    .command('sync')
    .argument('[path]', 'project root path', '.')
    .requiredOption('--target <target>', 'adapter target, currently: codex')
    .option('--force', 'overwrite generated target files')
    .description('Sync .ai governance files to a supported agent target')
    .action(async (targetPath: string, options: { target: string; force?: boolean }) => {
      const target = parseTarget(options.target);
      const result = await syncAdapters(path.resolve(targetPath), target, { force: options.force });

      console.log(`target=${result.target} files=${result.files.length}`);

      for (const file of result.files) {
        console.log(`file=${file.path} status=${file.status}`);
      }
    });

  adapter
    .command('doctor')
    .argument('[path]', 'project root path', '.')
    .option('--target <target>', 'adapter target, currently: codex', 'codex')
    .description('Check optional adapter installation and configuration')
    .action(async (targetPath: string, options: { target: string }) => {
      const target = parseTarget(options.target);
      const reports = await doctorAdapters(path.resolve(targetPath), { target });
      let hasFailure = false;

      for (const report of reports) {
        console.log(
          [
            `adapter=${report.name}`,
            `enabled=${report.enabled}`,
            `installed=${report.installed}`,
            `version="${report.version ?? ''}"`,
            `config=${report.configDetected}`,
            `hooks=${report.hooksDetected}`,
            `mcp=${report.mcpDetected}`,
            `conflict="${report.conflict}"`
          ].join(' ')
        );

        for (const check of report.checks) {
          console.log(
            `check="${check.command}" ok=${check.ok} output="${check.output ?? ''}" error="${check.error ?? ''}"`
          );
        }

        if (report.enabled && !report.installed) {
          hasFailure = true;
        }
      }

      if (hasFailure) {
        process.exitCode = 1;
      }
    });
}

function parseTarget(input: string): AdapterTarget {
  if (input === 'codex') {
    return input;
  }

  throw new Error(`Unsupported adapter target: ${input}`);
}
