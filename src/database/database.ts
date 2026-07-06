import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  IChunk,
  IChunkInput,
  IContextConfig,
  IProject,
  ISearchResult,
  IStats
} from '../types/context.js';
import { ensureDir, resolveConfiguredPath } from '../utils/paths.js';
import { runMigrations } from './migrations.js';

interface ICountRow {
  count: number;
}

interface ICacheRow {
  value: string;
}

export class ContextDatabase {
  private readonly db: Database.Database;
  readonly databasePath: string;

  constructor(config: IContextConfig) {
    this.databasePath = resolveConfiguredPath(config.database);
    ensureDir(path.dirname(this.databasePath));
    this.db = new Database(this.databasePath);
    runMigrations(this.db);
  }

  close(): void {
    this.db.close();
  }

  upsertProject(name: string, root: string): IProject {
    const now = new Date().toISOString();
    const normalizedRoot = path.resolve(root);

    this.db
      .prepare(
        `
        INSERT INTO projects (name, root, createdAt, updatedAt)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          root = excluded.root,
          updatedAt = excluded.updatedAt
      `
      )
      .run(name, normalizedRoot, now, now);

    return this.db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as IProject;
  }

  listProjects(): IProject[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY name ASC').all() as IProject[];
  }

  removeProject(name: string): boolean {
    const result = this.db.prepare('DELETE FROM projects WHERE name = ?').run(name);
    return result.changes > 0;
  }

  findProjectForPath(filePath: string): IProject | null {
    const normalizedPath = path.resolve(filePath);
    const projects = this.listProjects().sort((left, right) => right.root.length - left.root.length);

    return (
      projects.find((project) => {
        const root = path.resolve(project.root);
        return normalizedPath === root || normalizedPath.startsWith(`${root}${path.sep}`);
      }) ?? null
    );
  }

  getCache(key: string, scope = 'general'): string | null {
    const row = this.db.prepare('SELECT value FROM cache WHERE key = ? AND scope = ?').get(key, scope) as
      | ICacheRow
      | undefined;
    return row?.value ?? null;
  }

  setCache(key: string, value: string, scope = 'general'): void {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
        INSERT INTO cache (key, scope, value, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key, scope) DO UPDATE SET
          value = excluded.value,
          updatedAt = excluded.updatedAt
      `
      )
      .run(key, scope, value, now, now);
  }

  replaceChunksForPath(filePath: string, chunks: IChunkInput[]): number {
    const scope = chunks[0]?.scope ?? 'general';
    const replace = this.db.transaction(() => {
      this.db.prepare('DELETE FROM chunks WHERE path = ? AND scope = ?').run(filePath, scope);

      const statement = this.db.prepare(`
        INSERT INTO chunks (
          projectId,
          path,
          scope,
          kind,
          language,
          startLine,
          endLine,
          hash,
          content,
          createdAt
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const now = new Date().toISOString();

      for (const chunk of chunks) {
        statement.run(
          chunk.projectId,
          chunk.path,
          chunk.scope,
          chunk.kind,
          chunk.language,
          chunk.startLine,
          chunk.endLine,
          chunk.hash,
          chunk.content,
          now
        );
      }
    });

    replace();
    return chunks.length;
  }

  getChunk(id: number): IChunk | null {
    return (this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(id) as IChunk | undefined) ?? null;
  }

  search(query: string, limit: number): ISearchResult[] {
    return this.searchScoped(query, limit, 'general');
  }

  searchScoped(query: string, limit: number, scope = 'general'): ISearchResult[] {
    const ftsQuery = toFtsQuery(query);

    if (!ftsQuery) {
      return [];
    }

    return this.db
      .prepare(
        `
        SELECT
          c.id,
          c.projectId,
          c.path,
          c.scope,
          c.kind,
          c.language,
          c.startLine,
          c.endLine,
          c.hash,
          snippet(chunks_fts, 0, '[', ']', '...', 12) AS snippet,
          bm25(chunks_fts) AS rank
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ? AND c.scope = ?
        ORDER BY rank ASC
        LIMIT ?
      `
      )
      .all(ftsQuery, scope, limit) as ISearchResult[];
  }

  stats(): IStats {
    const projects = this.db.prepare('SELECT COUNT(*) AS count FROM projects').get() as ICountRow;
    const files = this.db.prepare('SELECT COUNT(DISTINCT path) AS count FROM chunks').get() as ICountRow;
    const chunks = this.db.prepare('SELECT COUNT(*) AS count FROM chunks').get() as ICountRow;
    const databaseBytes = fs.existsSync(this.databasePath) ? fs.statSync(this.databasePath).size : 0;

    return {
      projects: projects.count,
      files: files.count,
      chunks: chunks.count,
      databaseBytes
    };
  }
}

function toFtsQuery(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu);

  if (!tokens?.length) {
    return null;
  }

  return tokens.map((token) => `${token.replace(/"/g, '""')}*`).join(' ');
}
