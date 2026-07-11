import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  IChunk,
  IChunkInput,
  IContextConfig,
  IProject,
  IQaEntry,
  IQaFile,
  TQaPolicy,
  ISearchResult,
  IStats
} from '../types/context.js';
import { ensureDir, resolveConfiguredPath } from '../utils/paths.js';
import { runMigrations, type IMigrationReport } from './migrations.js';

interface ICountRow {
  count: number;
}

interface ICacheRow {
  value: string;
}

export interface IFlowFinding {
  id: number;
  projectId: number;
  runId: string;
  file: string | null;
  severity: 'low' | 'medium' | 'high';
  message: string;
  messageNorm: string;
  createdAt: string;
}

export class ContextDatabase {
  private readonly db: Database.Database;
  readonly databasePath: string;
  readonly migrationReports: IMigrationReport[];

  constructor(
    config: IContextConfig,
    options: {
      baseDir?: string;
    } = {}
  ) {
    this.databasePath = resolveConfiguredPath(config.database, options.baseDir);
    ensureDir(path.dirname(this.databasePath));

    try {
      this.db = new Database(this.databasePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to open Context Engine database at ${this.databasePath}: ${message}`);
    }

    this.migrationReports = runMigrations(this.db);
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

  storeQa(input: { projectId: number; question: string; normalized: string; hash: string; fingerprint: string; policy?: TQaPolicy; files?: IQaFile[]; summary: string; fullAnswer?: string; tokens?: number }): IQaEntry {
    const now = new Date().toISOString();
    const policy = input.policy ?? 'repository';
    const store = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT id, answerId FROM qa_questions WHERE projectId = ? AND questionHash = ? AND policy = ? AND fingerprint = ?').get(input.projectId, input.hash, policy, input.fingerprint) as { id: number; answerId: number } | undefined;
      if (existing) {
        this.db.prepare('UPDATE qa_answers SET summary = ?, fullAnswer = ?, sourceTokens = ?, updatedAt = ? WHERE id = ?').run(input.summary, input.fullAnswer ?? null, input.tokens ?? null, now, existing.answerId);
        this.db.prepare('UPDATE qa_questions SET rawQuestion = ?, normalizedQuestion = ?, lastUsedAt = ? WHERE id = ?').run(input.question, input.normalized, now, existing.id);
        this.replaceQaFiles(existing.id, input.files ?? []);
        return existing.id;
      }
      const shared = this.db.prepare('SELECT id FROM qa_answers WHERE projectId = ? AND summary = ? AND COALESCE(fullAnswer, ?) = ? ORDER BY id LIMIT 1').get(input.projectId, input.summary, '', input.fullAnswer ?? '') as { id: number } | undefined;
      const answerId = shared?.id ?? Number(this.db.prepare('INSERT INTO qa_answers (projectId, summary, fullAnswer, sourceTokens, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run(input.projectId, input.summary, input.fullAnswer ?? null, input.tokens ?? null, now, now).lastInsertRowid);
      const question = this.db.prepare('INSERT INTO qa_questions (projectId, answerId, rawQuestion, normalizedQuestion, questionHash, policy, fingerprint, createdAt, lastUsedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(input.projectId, answerId, input.question, input.normalized, input.hash, policy, input.fingerprint, now, now);
      const id = Number(question.lastInsertRowid);
      this.replaceQaFiles(id, input.files ?? []);
      return id;
    });
    return this.getQaById(store())!;
  }

  getQaById(id: number): IQaEntry | null {
    const row = this.db.prepare('SELECT q.*, a.summary, a.fullAnswer, a.sourceTokens FROM qa_questions q JOIN qa_answers a ON a.id = q.answerId WHERE q.id = ?').get(id) as Omit<IQaEntry, 'files'> | undefined;
    return row ? this.hydrateQa(row) : null;
  }

  findQaExact(projectId: number, hash: string): IQaEntry[] {
    const rows = this.db.prepare('SELECT q.*, a.summary, a.fullAnswer, a.sourceTokens FROM qa_questions q JOIN qa_answers a ON a.id = q.answerId WHERE q.projectId = ? AND q.questionHash = ? ORDER BY q.lastUsedAt DESC').all(projectId, hash) as Array<Omit<IQaEntry, 'files'>>;
    return rows.map((row) => this.hydrateQa(row));
  }

  findQaLexical(projectId: number, query: string, limit = 3): IQaEntry[] {
    const fts = toFtsAnyQuery(query);
    if (!fts) return [];
    const rows = this.db.prepare(`SELECT q.*, a.summary, a.fullAnswer, a.sourceTokens FROM qa_questions_fts f JOIN qa_questions q ON q.id = f.rowid JOIN qa_answers a ON a.id = q.answerId WHERE qa_questions_fts MATCH ? AND q.projectId = ? ORDER BY bm25(qa_questions_fts) LIMIT ?`).all(fts, projectId, limit) as Array<Omit<IQaEntry, 'files'>>;
    return rows.map((row) => this.hydrateQa(row));
  }

  touchQa(id: number): void {
    this.db.prepare('UPDATE qa_questions SET hitCount = hitCount + 1, lastUsedAt = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  listQa(projectId?: number): IQaEntry[] {
    const sql = 'SELECT q.*, a.summary, a.fullAnswer, a.sourceTokens FROM qa_questions q JOIN qa_answers a ON a.id = q.answerId';
    const rows = (projectId ? this.db.prepare(`${sql} WHERE q.projectId = ? ORDER BY q.lastUsedAt DESC`).all(projectId) : this.db.prepare(`${sql} ORDER BY q.lastUsedAt DESC`).all()) as Array<Omit<IQaEntry, 'files'>>;
    return rows.map((row) => this.hydrateQa(row));
  }

  reclassifyQa(id: number, policy: TQaPolicy, fingerprint: string, files: IQaFile[]): IQaEntry {
    const update = this.db.transaction(() => {
      const current = this.getQaById(id);
      if (!current) throw new Error(`Unknown Q&A entry: ${id}`);
      this.db.prepare('UPDATE qa_questions SET policy = ?, fingerprint = ? WHERE id = ?').run(policy, fingerprint, id);
      this.replaceQaFiles(id, files);
    });
    update();
    return this.getQaById(id)!;
  }

  pruneQa(ids: number[], dryRun = false): { entries: number; orphanAnswers: number; logicalBytes: number } {
    if (!ids.length) return { entries: 0, orphanAnswers: 0, logicalBytes: 0 };
    const placeholders = ids.map(() => '?').join(',');
    const questionSize = this.db.prepare(`SELECT COALESCE(SUM(length(rawQuestion) + length(normalizedQuestion) + length(questionHash) + length(policy) + length(fingerprint)), 0) AS bytes FROM qa_questions WHERE id IN (${placeholders})`).get(...ids) as { bytes: number };
    const fileSize = this.db.prepare(`SELECT COALESCE(SUM(length(filePath) + length(fileHash)), 0) AS bytes FROM qa_question_files WHERE questionId IN (${placeholders})`).get(...ids) as { bytes: number };
    const answerIds = this.db.prepare(`SELECT DISTINCT answerId FROM qa_questions WHERE id IN (${placeholders})`).all(...ids) as Array<{ answerId: number }>;
    const orphanAnswerIds = answerIds.filter(({ answerId }) => {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM qa_questions WHERE answerId = ? AND id NOT IN (${placeholders})`).get(answerId, ...ids) as ICountRow;
      return row.count === 0;
    }).map(({ answerId }) => answerId);
    const answerSize = orphanAnswerIds.length ? this.db.prepare(`SELECT COALESCE(SUM(length(summary) + length(COALESCE(fullAnswer, ''))), 0) AS bytes FROM qa_answers WHERE id IN (${orphanAnswerIds.map(() => '?').join(',')})`).get(...orphanAnswerIds) as { bytes: number } : { bytes: 0 };
    if (!dryRun) this.db.transaction(() => {
      this.db.prepare(`DELETE FROM qa_questions WHERE id IN (${placeholders})`).run(...ids);
      for (const { answerId } of answerIds) this.db.prepare('DELETE FROM qa_answers WHERE id = ? AND NOT EXISTS (SELECT 1 FROM qa_questions WHERE answerId = ?)').run(answerId, answerId);
    })();
    return { entries: ids.length, orphanAnswers: orphanAnswerIds.length, logicalBytes: questionSize.bytes + fileSize.bytes + answerSize.bytes };
  }

  private hydrateQa(row: Omit<IQaEntry, 'files'>): IQaEntry {
    const files = this.db.prepare('SELECT filePath, fileHash FROM qa_question_files WHERE questionId = ? ORDER BY filePath').all(row.id) as IQaFile[];
    return { ...row, files };
  }

  private replaceQaFiles(questionId: number, files: IQaFile[]): void {
    this.db.prepare('DELETE FROM qa_question_files WHERE questionId = ?').run(questionId);
    const insert = this.db.prepare('INSERT INTO qa_question_files (questionId, filePath, fileHash) VALUES (?, ?, ?)');
    for (const file of files) insert.run(questionId, file.filePath, file.fileHash);
  }

  invalidateQa(id: number): boolean {
    const answer = this.db.prepare('SELECT answerId FROM qa_questions WHERE id = ?').get(id) as { answerId: number } | undefined;
    if (!answer) return false;
    this.db.prepare('DELETE FROM qa_questions WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM qa_answers WHERE id = ? AND NOT EXISTS (SELECT 1 FROM qa_questions WHERE answerId = ?)').run(answer.answerId, answer.answerId);
    return true;
  }

  createFlowRun(input: { id: string; projectId: number; task: string; mode: string; tier: string; status: string; worktreePath?: string }): void {
    this.db.prepare('INSERT INTO flow_runs (id, projectId, task, mode, tier, status, worktreePath, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(input.id, input.projectId, input.task, input.mode, input.tier, input.status, input.worktreePath ?? null, new Date().toISOString());
  }

  addFlowStep(input: { runId: string; phase: string; agent: string; model: string; status: string; durationMs: number; inputTokens?: number | null; outputTokens?: number | null; exitCode?: number | null; summary?: string; error?: string; modelClaimedApproved?: boolean | null; approved?: boolean | null }): void {
    this.db.prepare('INSERT INTO flow_steps (runId, phase, agent, model, status, durationMs, inputTokens, outputTokens, exitCode, summary, error, modelClaimedApproved, approved, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(input.runId, input.phase, input.agent, input.model, input.status, input.durationMs, input.inputTokens ?? null, input.outputTokens ?? null, input.exitCode ?? null, input.summary ?? null, input.error ?? null, input.modelClaimedApproved == null ? null : Number(input.modelClaimedApproved), input.approved == null ? null : Number(input.approved), new Date().toISOString());
  }

  addFlowFinding(input: { projectId: number; runId: string; file?: string | null; severity: 'low' | 'medium' | 'high'; message: string; messageNorm: string }): IFlowFinding {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO flow_findings (projectId, runId, file, severity, message, messageNorm, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(input.projectId, input.runId, input.file ?? null, input.severity, input.message, input.messageNorm, createdAt);
    return this.db.prepare('SELECT * FROM flow_findings WHERE id = ?').get(Number(result.lastInsertRowid)) as IFlowFinding;
  }

  listFlowFindings(projectId: number, file?: string): IFlowFinding[] {
    return (file === undefined ? this.db.prepare('SELECT * FROM flow_findings WHERE projectId = ? ORDER BY createdAt DESC, id DESC').all(projectId) : this.db.prepare('SELECT * FROM flow_findings WHERE projectId = ? AND file = ? ORDER BY createdAt DESC, id DESC').all(projectId, file)) as IFlowFinding[];
  }

  finishFlowRun(id: string, input: { status: string; patchPath?: string; iterations: number; error?: string }): void {
    this.db.prepare('UPDATE flow_runs SET status = ?, patchPath = ?, iterations = ?, error = ?, finishedAt = ? WHERE id = ?').run(input.status, input.patchPath ?? null, input.iterations, input.error ?? null, new Date().toISOString(), id);
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

  searchProject(query: string, projectId: number, limit: number, scope = 'general'): ISearchResult[] {
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return [];
    return this.db.prepare(`
      SELECT c.id, c.projectId, c.path, c.scope, c.kind, c.language, c.startLine, c.endLine, c.hash,
        snippet(chunks_fts, 0, '[', ']', '...', 12) AS snippet, bm25(chunks_fts) AS rank
      FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
      WHERE chunks_fts MATCH ? AND c.projectId = ? AND c.scope = ?
      ORDER BY rank ASC LIMIT ?
    `).all(ftsQuery, projectId, scope, limit) as ISearchResult[];
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

function toFtsAnyQuery(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu);
  if (!tokens?.length) return null;
  return [...new Set(tokens)].map((token) => `${token.replace(/"/g, '""')}*`).join(' OR ');
}
