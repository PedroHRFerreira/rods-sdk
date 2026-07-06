import { Command } from 'commander';
import { registerAdapterCommand } from './commands/adapter.js';
import { registerIngestCommand } from './commands/ingest.js';
import { registerInitCommand } from './commands/init.js';
import { registerProjectsCommand } from './commands/projects.js';
import { registerReadCommand } from './commands/read.js';
import { registerSearchCommand } from './commands/search.js';
import { registerStatsCommand } from './commands/stats.js';
import { registerUpgradeCommand } from './commands/upgrade.js';

const program = new Command();

program
  .name('rods')
  .description('Agent governance framework with Context Engine retrieval and RTK-first token economy')
  .version('0.1.0')
  .showHelpAfterError();

registerIngestCommand(program);
registerSearchCommand(program);
registerReadCommand(program);
registerStatsCommand(program);
registerProjectsCommand(program);
registerInitCommand(program);
registerAdapterCommand(program);
registerUpgradeCommand(program);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
