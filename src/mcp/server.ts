import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import process from 'node:process';
import { z } from 'zod';
import { ContextDatabase } from '../database/database.js';
import { loadConfig } from '../services/config.js';
import { IndexerService, normalizeScope } from '../services/indexer.js';
import { detectKind } from '../utils/kind.js';

const INSTRUCTIONS = [
  'Context Engine is a local memory layer for code agents.',
  'Use search before reading large files or logs.',
  'Read only explicit chunk ids returned by search.',
  'Ingest a project or file when context is missing or stale.',
  'Return compact excerpts instead of full files whenever possible.'
].join(' ');

const server = new McpServer(
  {
    name: 'context-engine',
    version: '0.1.0'
  },
  {
    instructions: INSTRUCTIONS
  }
);

server.tool(
  'search',
  'Search indexed chunks with SQLite FTS5/BM25. Use this before opening large files.',
  {
    query: z.string().min(1),
    scope: z.string().min(1).optional(),
    limit: z.number().int().positive().max(50).optional()
  },
  async ({ query, scope, limit }) => {
    const { db, close, config } = openContext();

    try {
      const results = db.searchScoped(query, limit ?? config.searchLimit, normalizeScope(scope));
      return toJsonResult({
        results: results.map((result) => ({
          id: result.id,
          path: result.path,
          scope: result.scope,
          kind: result.kind,
          language: result.language,
          lines: `${result.startLine}-${result.endLine}`,
          score: result.rank,
          snippet: result.snippet.replace(/\s+/g, ' ').trim()
        }))
      });
    } finally {
      close();
    }
  }
);

server.tool(
  'read',
  'Read one indexed chunk by id. Do not use this to read whole files.',
  {
    chunkId: z.number().int().positive()
  },
  async ({ chunkId }) => {
    const { db, close } = openContext();

    try {
      const chunk = db.getChunk(chunkId);

      if (!chunk) {
        return toJsonResult({ error: 'chunk_not_found', chunkId });
      }

      return toJsonResult({
        id: chunk.id,
        path: chunk.path,
        kind: chunk.kind,
        language: chunk.language,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content
      });
    } finally {
      close();
    }
  }
);

server.tool(
  'ingest',
  'Index a file or directory into Context Engine chunks.',
  {
    path: z.string().min(1),
    scope: z.string().min(1).optional(),
    type: z
      .enum(['file', 'log', 'diff', 'markdown', 'error', 'stacktrace', 'json', 'sql', 'http'])
      .optional()
  },
  async ({ path, scope, type }) => {
    const { db, close, config } = openContext();

    try {
      const indexer = new IndexerService(db, config);
      const summary = await indexer.ingestPath(path, {
        type: type ? detectKind(path, type) : undefined,
        scope: normalizeScope(scope)
      });

      return toJsonResult(summary);
    } finally {
      close();
    }
  }
);

server.tool('stats', 'Show compact index statistics.', {}, async () => {
  const { db, close } = openContext();

  try {
    return toJsonResult(db.stats());
  } finally {
    close();
  }
});

server.tool('projects', 'List registered projects.', {}, async () => {
  const { db, close } = openContext();

  try {
    return toJsonResult({
      projects: db.listProjects().map((project) => ({
        id: project.id,
        name: project.name,
        root: project.root,
        updatedAt: project.updatedAt
      }))
    });
  } finally {
    close();
  }
});

server.tool(
  'project_add',
  'Register or update a project root.',
  {
    name: z.string().min(1),
    root: z.string().min(1)
  },
  async ({ name, root }) => {
    const { db, close } = openContext();

    try {
      return toJsonResult(db.upsertProject(name, root));
    } finally {
      close();
    }
  }
);

function openContext() {
  const config = loadConfig();
  const db = new ContextDatabase(config);

  return {
    config,
    db,
    close: () => db.close()
  };
}

function toJsonResult<TData extends object>(data: TData) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data)
      }
    ],
    structuredContent: data as Record<string, unknown>
  };
}

await server.connect(new StdioServerTransport());
process.stdin.resume();

const keepAlive = setInterval(() => undefined, 2_147_483_647);
process.stdin.on('end', () => clearInterval(keepAlive));
