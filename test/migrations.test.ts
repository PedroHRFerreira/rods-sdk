import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import { runMigrations } from '../src/database/migrations.js';

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

    runMigrations(db);

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
  } finally {
    db.close();
  }
});
