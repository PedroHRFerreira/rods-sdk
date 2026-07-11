import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerAdapterCommand } from './commands/adapter.js';
import { registerIngestCommand } from './commands/ingest.js';
import { registerEscalationCommand } from './commands/escalation.js';
import { registerHookCommand } from './commands/hook.js';
import { registerFlowCommand } from './commands/flow.js';
import { registerInitCommand } from './commands/init.js';
import { registerProjectsCommand } from './commands/projects.js';
import { registerQaCommand } from './commands/qa.js';
import { registerReadCommand } from './commands/read.js';
import { registerSearchCommand } from './commands/search.js';
import { registerStatsCommand } from './commands/stats.js';
import { registerUpgradeCommand } from './commands/upgrade.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.join(currentDir, '../package.json');
const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

const program = new Command();

program
  .name('rods')
  .description('Agent governance framework with Context Engine retrieval and RTK-first token economy')
  .version(version)
  .showHelpAfterError();

registerIngestCommand(program);
registerEscalationCommand(program);
registerHookCommand(program);
registerFlowCommand(program);
registerSearchCommand(program);
registerReadCommand(program);
registerStatsCommand(program);
registerProjectsCommand(program);
registerQaCommand(program);
registerInitCommand(program);
registerAdapterCommand(program);
registerUpgradeCommand(program);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
