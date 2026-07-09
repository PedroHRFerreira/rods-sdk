import readline from 'node:readline';
import type { Command } from 'commander';
import { createHookResponse } from '../services/hook-runner.js';
import { isAdapterTarget, type AdapterTarget } from '../services/adapters.js';

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  const input = readline.createInterface({ input: process.stdin });
  for await (const line of input) chunks.push(String(line));
  return chunks.join('\n');
}

export function registerHookCommand(program: Command): void {
  program
    .command('hook')
    .description('Run a harness lifecycle hook')
    .command('run')
    .requiredOption('--target <target>', 'hook target: codex or claude')
    .action(async (options: { target: string }) => {
      if (!isAdapterTarget(options.target)) throw new Error(`Unsupported hook target: ${options.target}`);
      const raw = await readStdin();
      let input: Record<string, unknown> = {};
      try {
        input = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {};
      } catch {
        process.exitCode = 0;
        return;
      }
      try {
        const response = await createHookResponse(options.target as AdapterTarget, {
          hook_event_name: typeof input.hook_event_name === 'string' ? input.hook_event_name : undefined,
          prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
          cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
          model: typeof input.model === 'string' ? input.model : undefined
        });
        if (response) console.log(JSON.stringify(response));
      } catch {
        // Hook failures are fail-open: the original prompt must still reach the harness.
        process.exitCode = 0;
      }
    });
}
