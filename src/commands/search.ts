import type { Command } from 'commander';
import { ContextDatabase } from '../database/database.js';
import { loadConfig } from '../services/config.js';
import { normalizeScope } from '../services/indexer.js';

export function registerSearchCommand(program: Command): void {
  program
    .command('search')
    .argument('<query>', 'text to search')
    .option('--limit <limit>', 'maximum results')
    .option('--scope <scope>', 'search scope', 'general')
    .description('Search indexed chunks using SQLite FTS5')
    .action((query: string, options: { limit?: string; scope?: string }) => {
      const config = loadConfig();
      const limit = parseLimit(options.limit, config.searchLimit);
      const scope = normalizeScope(options.scope);
      const db = new ContextDatabase(config);

      try {
        const results = db.searchScoped(query, limit, scope);

        if (results.length === 0) {
          console.log('results=0');
          return;
        }

        for (const result of results) {
          console.log(
            `id=${result.id} score=${result.rank.toFixed(4)} scope=${result.scope} lines=${result.startLine}-${result.endLine} type=${result.kind} path=${result.path}`
          );
          console.log(`snippet=${result.snippet.replace(/\s+/g, ' ').trim()}`);
        }
      } finally {
        db.close();
      }
    });
}

function parseLimit(input: string | undefined, fallback: number): number {
  if (!input) {
    return fallback;
  }

  const parsed = Number.parseInt(input, 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid limit: ${input}`);
  }

  return parsed;
}
