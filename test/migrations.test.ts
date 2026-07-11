import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import { inspectMigrations, runMigrations } from '../src/database/migrations.js';

test('runMigrations backfills scope for pre-scope databases without data loss', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-migration-'));
  const dbPath = path.join(root, 'context.db');
  const db = new Database(dbPath);

  try {
    db.exec(`
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        projectId INTEGER,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        language TEXT NOT NULL,
        startLine INTEGER NOT NULL,
        endLine INTEGER NOT NULL,
        hash TEXT NOT NULL,
        content TEXT NOT NULL,
        embeddingModel TEXT,
        embeddingDimensions INTEGER,
        embedding BLOB,
        createdAt TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        content,
        path,
        kind UNINDEXED,
        language UNINDEXED,
        content='chunks',
        content_rowid='id'
      );
      CREATE TABLE cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      INSERT INTO chunks (path, kind, language, startLine, endLine, hash, content, createdAt)
      VALUES ('/tmp/file.ts', 'file', 'typescript', 1, 1, 'hash', 'legacy token', '2026-01-01T00:00:00.000Z');
      INSERT INTO chunks_fts(rowid, content, path, kind, language)
      VALUES (1, 'legacy token', '/tmp/file.ts', 'file', 'typescript');
      INSERT INTO cache (key, value, createdAt, updatedAt)
      VALUES ('file:/tmp/file.ts:file', 'hash', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);

    const firstRun = runMigrations(db);

    const row = db.prepare('SELECT scope, content FROM chunks WHERE id = 1').get() as {
      scope: string;
      content: string;
    };
    const fts = db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'legacy*'").all();
    const cache = db.prepare("SELECT scope, value FROM cache WHERE key = 'file:/tmp/file.ts:file'").get() as {
      scope: string;
      value: string;
    };

    assert.equal(row.scope, 'general');
    assert.equal(row.content, 'legacy token');
    assert.equal(fts.length, 1);
    assert.equal(cache.scope, 'general');
    assert.equal(cache.value, 'hash');
    assert.equal(firstRun.find((report) => report.migration === 'scope-column')?.status, 'changed');
    assert.equal(firstRun.find((report) => report.migration === 'cache-scope-column')?.status, 'changed');

    const dryRun = inspectMigrations(db);
    assert.equal(dryRun.find((report) => report.migration === 'scope-column')?.status, 'unchanged');
    assert.equal(dryRun.find((report) => report.migration === 'cache-scope-column')?.status, 'unchanged');

    const secondRun = runMigrations(db);
    assert.equal(secondRun.find((report) => report.migration === 'scope-column')?.status, 'unchanged');
    assert.equal(secondRun.find((report) => report.migration === 'cache-scope-column')?.status, 'unchanged');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')").all() as Array<{ name: string }>;
    for (const name of ['qa_answers','qa_questions','qa_questions_fts','flow_runs','flow_steps','qa_questions_ai','qa_questions_ad','qa_questions_au']) assert.ok(tables.some((entry) => entry.name === name), `missing ${name}`);
  } finally {
    db.close();
  }
});

test('runMigrations classifies legacy Q&A rows as repository and preserves their data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-policy-migration-'));
  const db = new Database(path.join(root, 'context.db'));
  try {
    db.exec(`
      CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, root TEXT NOT NULL UNIQUE, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE qa_answers (id INTEGER PRIMARY KEY AUTOINCREMENT, projectId INTEGER NOT NULL, summary TEXT NOT NULL, fullAnswer TEXT, sourceTokens INTEGER, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE qa_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, projectId INTEGER NOT NULL, answerId INTEGER NOT NULL,
        rawQuestion TEXT NOT NULL, normalizedQuestion TEXT NOT NULL, questionHash TEXT NOT NULL,
        fingerprint TEXT NOT NULL, normalizationVersion INTEGER NOT NULL DEFAULT 1,
        hitCount INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, lastUsedAt TEXT NOT NULL,
        UNIQUE(projectId, questionHash, fingerprint)
      );
      INSERT INTO projects VALUES (7, 'legacy', '/tmp/legacy', 'created', 'updated');
      INSERT INTO qa_answers VALUES (8, 7, 'summary', 'full', 42, 'created', 'updated');
      INSERT INTO qa_questions VALUES (9, 7, 8, 'Raw?', 'raw', 'hash', 'legacy-fingerprint', 1, 3, 'created', 'used');
    `);
    const first = runMigrations(db);
    const row = db.prepare('SELECT * FROM qa_questions WHERE id = 9').get() as { policy: string; fingerprint: string; hitCount: number };
    assert.equal(row.policy, 'repository'); assert.equal(row.fingerprint, 'legacy-fingerprint'); assert.equal(row.hitCount, 3);
    assert.equal(first.find((report) => report.migration === 'qa-validity-policy')?.status, 'changed');
    const columns = db.prepare('PRAGMA table_info(qa_questions)').all() as Array<{ name: string; notnull: number }>;
    assert.equal(columns.find((column) => column.name === 'policy')?.notnull, 1);
    assert.doesNotThrow(() => db.prepare("INSERT INTO qa_question_files VALUES (9, 'README.md', 'hash')").run());
    assert.equal(runMigrations(db).find((report) => report.migration === 'qa-validity-policy')?.status, 'unchanged');
    assert.equal(inspectMigrations(db).find((report) => report.migration === 'qa-validity-policy')?.status, 'unchanged');
  } finally { db.close(); }
});
