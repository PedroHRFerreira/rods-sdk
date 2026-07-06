import type Database from 'better-sqlite3';

export function runMigrations(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      root TEXT NOT NULL UNIQUE,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId INTEGER,
      path TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'general',
      kind TEXT NOT NULL,
      language TEXT NOT NULL,
      startLine INTEGER NOT NULL,
      endLine INTEGER NOT NULL,
      hash TEXT NOT NULL,
      content TEXT NOT NULL,
      embeddingModel TEXT,
      embeddingDimensions INTEGER,
      embedding BLOB,
      createdAt TEXT NOT NULL,
      FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
    CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks(projectId);
    CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(hash);

    CREATE TABLE IF NOT EXISTS cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'general',
      value TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE(key, scope)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content,
      path,
      scope UNINDEXED,
      kind UNINDEXED,
      language UNINDEXED,
      content='chunks',
      content_rowid='id'
    );

  `);

  migrateScope(db);
  migrateCacheScope(db);
  db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_scope ON chunks(scope)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cache_scope ON cache(scope)');
  createChunkTriggers(db);
}

function migrateScope(db: Database.Database): void {
  const chunkColumns = db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>;
  const hasChunkScope = chunkColumns.some((column) => column.name === 'scope');

  if (!hasChunkScope) {
    db.exec("ALTER TABLE chunks ADD COLUMN scope TEXT NOT NULL DEFAULT 'general'");
  }

  const ftsColumns = db.prepare('PRAGMA table_info(chunks_fts)').all() as Array<{ name: string }>;
  const hasFtsScope = ftsColumns.some((column) => column.name === 'scope');

  if (!hasFtsScope) {
    db.exec(`
      DROP TRIGGER IF EXISTS chunks_ai;
      DROP TRIGGER IF EXISTS chunks_ad;
      DROP TRIGGER IF EXISTS chunks_au;
      DROP TABLE IF EXISTS chunks_fts;
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        content,
        path,
        scope UNINDEXED,
        kind UNINDEXED,
        language UNINDEXED,
        content='chunks',
        content_rowid='id'
      );
      INSERT INTO chunks_fts(rowid, content, path, scope, kind, language)
      SELECT id, content, path, scope, kind, language FROM chunks;
    `);
  }

  db.exec("UPDATE chunks SET scope = 'general' WHERE scope IS NULL OR scope = ''");
}

function migrateCacheScope(db: Database.Database): void {
  const cacheColumns = db.prepare('PRAGMA table_info(cache)').all() as Array<{ name: string }>;
  const hasCacheScope = cacheColumns.some((column) => column.name === 'scope');

  if (hasCacheScope) {
    db.exec("UPDATE cache SET scope = 'general' WHERE scope IS NULL OR scope = ''");
    return;
  }

  db.exec(`
    ALTER TABLE cache RENAME TO cache_legacy;
    CREATE TABLE cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'general',
      value TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE(key, scope)
    );
    INSERT INTO cache (id, key, scope, value, createdAt, updatedAt)
    SELECT id, key, 'general', value, createdAt, updatedAt FROM cache_legacy;
    DROP TABLE cache_legacy;
  `);
}

function createChunkTriggers(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS chunks_ai;
    DROP TRIGGER IF EXISTS chunks_ad;
    DROP TRIGGER IF EXISTS chunks_au;

    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content, path, scope, kind, language)
      VALUES (new.id, new.content, new.path, new.scope, new.kind, new.language);
    END;

    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, path, scope, kind, language)
      VALUES ('delete', old.id, old.content, old.path, old.scope, old.kind, old.language);
    END;

    CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, path, scope, kind, language)
      VALUES ('delete', old.id, old.content, old.path, old.scope, old.kind, old.language);
      INSERT INTO chunks_fts(rowid, content, path, scope, kind, language)
      VALUES (new.id, new.content, new.path, new.scope, new.kind, new.language);
    END;
  `);
}
