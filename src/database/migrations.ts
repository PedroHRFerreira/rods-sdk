import type Database from 'better-sqlite3';

export type MigrationStatus = 'changed' | 'unchanged' | 'would-migrate';

export interface IMigrationReport {
  migration: string;
  status: MigrationStatus;
  reason?: string;
}

interface IColumnInfo {
  name: string;
}

export function runMigrations(db: Database.Database): IMigrationReport[] {
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

    CREATE TABLE IF NOT EXISTS qa_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId INTEGER NOT NULL,
      summary TEXT NOT NULL,
      fullAnswer TEXT,
      sourceTokens INTEGER,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS qa_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId INTEGER NOT NULL,
      answerId INTEGER NOT NULL,
      rawQuestion TEXT NOT NULL,
      normalizedQuestion TEXT NOT NULL,
      questionHash TEXT NOT NULL,
      policy TEXT NOT NULL CHECK (policy IN ('conceptual', 'files', 'repository')),
      fingerprint TEXT NOT NULL,
      normalizationVersion INTEGER NOT NULL DEFAULT 1,
      hitCount INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      lastUsedAt TEXT NOT NULL,
      FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(answerId) REFERENCES qa_answers(id) ON DELETE CASCADE,
      UNIQUE(projectId, questionHash, policy, fingerprint)
    );

    CREATE TABLE IF NOT EXISTS qa_question_files (
      questionId INTEGER NOT NULL,
      filePath TEXT NOT NULL,
      fileHash TEXT NOT NULL,
      PRIMARY KEY(questionId, filePath),
      FOREIGN KEY(questionId) REFERENCES qa_questions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_qa_questions_hash ON qa_questions(projectId, questionHash);
    CREATE INDEX IF NOT EXISTS idx_qa_questions_project ON qa_questions(projectId);
    CREATE VIRTUAL TABLE IF NOT EXISTS qa_questions_fts USING fts5(
      normalizedQuestion,
      projectId UNINDEXED,
      content='qa_questions',
      content_rowid='id'
    );

    CREATE TABLE IF NOT EXISTS flow_runs (
      id TEXT PRIMARY KEY,
      projectId INTEGER NOT NULL,
      task TEXT NOT NULL,
      mode TEXT NOT NULL,
      tier TEXT NOT NULL,
      status TEXT NOT NULL,
      worktreePath TEXT,
      patchPath TEXT,
      iterations INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      finishedAt TEXT,
      error TEXT,
      FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS flow_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId TEXT NOT NULL,
      phase TEXT NOT NULL,
      agent TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      durationMs INTEGER NOT NULL,
      inputTokens INTEGER,
      outputTokens INTEGER,
      exitCode INTEGER,
      summary TEXT,
      error TEXT,
      modelClaimedApproved INTEGER,
      approved INTEGER,
      createdAt TEXT NOT NULL,
      FOREIGN KEY(runId) REFERENCES flow_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS flow_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId INTEGER NOT NULL,
      runId TEXT NOT NULL,
      file TEXT,
      severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
      message TEXT NOT NULL,
      messageNorm TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(runId) REFERENCES flow_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_flow_findings_file ON flow_findings(projectId, file);
    CREATE INDEX IF NOT EXISTS idx_flow_findings_norm ON flow_findings(projectId, messageNorm);

  `);

  const reports = [migrateScope(db), migrateCacheScope(db), migrateQaValidityPolicy(db), migrateFlowReviewMetadata(db)];
  db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_scope ON chunks(scope)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cache_scope ON cache(scope)');
  createChunkTriggers(db);
  createQaTriggers(db);

  return reports;
}

function createQaTriggers(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS qa_questions_ai;
    DROP TRIGGER IF EXISTS qa_questions_ad;
    DROP TRIGGER IF EXISTS qa_questions_au;
    CREATE TRIGGER qa_questions_ai AFTER INSERT ON qa_questions BEGIN
      INSERT INTO qa_questions_fts(rowid, normalizedQuestion, projectId)
      VALUES (new.id, new.normalizedQuestion, new.projectId);
    END;
    CREATE TRIGGER qa_questions_ad AFTER DELETE ON qa_questions BEGIN
      INSERT INTO qa_questions_fts(qa_questions_fts, rowid, normalizedQuestion, projectId)
      VALUES ('delete', old.id, old.normalizedQuestion, old.projectId);
    END;
    CREATE TRIGGER qa_questions_au AFTER UPDATE ON qa_questions BEGIN
      INSERT INTO qa_questions_fts(qa_questions_fts, rowid, normalizedQuestion, projectId)
      VALUES ('delete', old.id, old.normalizedQuestion, old.projectId);
      INSERT INTO qa_questions_fts(rowid, normalizedQuestion, projectId)
      VALUES (new.id, new.normalizedQuestion, new.projectId);
    END;
  `);
}

export function inspectMigrations(db: Database.Database): IMigrationReport[] {
  return [inspectScopeMigration(db), inspectCacheScopeMigration(db), inspectQaValidityPolicy(db), inspectFlowReviewMetadata(db)];
}

function migrateFlowReviewMetadata(db: Database.Database): IMigrationReport {
  const inspection = inspectFlowReviewMetadata(db);
  if (inspection.status === 'unchanged') return inspection;
  if (!hasColumn(db, 'flow_steps', 'modelClaimedApproved')) db.exec('ALTER TABLE flow_steps ADD COLUMN modelClaimedApproved INTEGER');
  if (!hasColumn(db, 'flow_steps', 'approved')) db.exec('ALTER TABLE flow_steps ADD COLUMN approved INTEGER');
  return { migration: 'flow-review-metadata', status: 'changed' };
}

function inspectFlowReviewMetadata(db: Database.Database): IMigrationReport {
  if (hasColumn(db, 'flow_steps', 'modelClaimedApproved') && hasColumn(db, 'flow_steps', 'approved') && tableExists(db, 'flow_findings')) return { migration: 'flow-review-metadata', status: 'unchanged', reason: 'already-applied' };
  return { migration: 'flow-review-metadata', status: 'would-migrate' };
}

function migrateQaValidityPolicy(db: Database.Database): IMigrationReport {
  const inspection = inspectQaValidityPolicy(db);
  if (inspection.status === 'unchanged') return inspection;

  db.transaction(() => {
    db.exec(`
      DROP TRIGGER IF EXISTS qa_questions_ai;
      DROP TRIGGER IF EXISTS qa_questions_ad;
      DROP TRIGGER IF EXISTS qa_questions_au;
      DROP TABLE IF EXISTS qa_questions_fts;
      DROP TABLE IF EXISTS qa_question_files;
      ALTER TABLE qa_questions RENAME TO qa_questions_legacy;
      CREATE TABLE qa_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        projectId INTEGER NOT NULL,
        answerId INTEGER NOT NULL,
        rawQuestion TEXT NOT NULL,
        normalizedQuestion TEXT NOT NULL,
        questionHash TEXT NOT NULL,
        policy TEXT NOT NULL CHECK (policy IN ('conceptual', 'files', 'repository')),
        fingerprint TEXT NOT NULL,
        normalizationVersion INTEGER NOT NULL DEFAULT 1,
        hitCount INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        lastUsedAt TEXT NOT NULL,
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(answerId) REFERENCES qa_answers(id) ON DELETE CASCADE,
        UNIQUE(projectId, questionHash, policy, fingerprint)
      );
      INSERT INTO qa_questions (
        id, projectId, answerId, rawQuestion, normalizedQuestion, questionHash,
        policy, fingerprint, normalizationVersion, hitCount, createdAt, lastUsedAt
      )
      SELECT id, projectId, answerId, rawQuestion, normalizedQuestion, questionHash,
        'repository', fingerprint, normalizationVersion, hitCount, createdAt, lastUsedAt
      FROM qa_questions_legacy;
      DROP TABLE qa_questions_legacy;
      CREATE TABLE IF NOT EXISTS qa_question_files (
        questionId INTEGER NOT NULL,
        filePath TEXT NOT NULL,
        fileHash TEXT NOT NULL,
        PRIMARY KEY(questionId, filePath),
        FOREIGN KEY(questionId) REFERENCES qa_questions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_qa_questions_hash ON qa_questions(projectId, questionHash);
      CREATE INDEX IF NOT EXISTS idx_qa_questions_project ON qa_questions(projectId);
      CREATE VIRTUAL TABLE qa_questions_fts USING fts5(
        normalizedQuestion,
        projectId UNINDEXED,
        content='qa_questions',
        content_rowid='id'
      );
      INSERT INTO qa_questions_fts(rowid, normalizedQuestion, projectId)
      SELECT id, normalizedQuestion, projectId FROM qa_questions;
    `);
  })();
  return { migration: 'qa-validity-policy', status: 'changed' };
}

function migrateScope(db: Database.Database): IMigrationReport {
  const inspection = inspectScopeMigration(db);

  if (inspection.status === 'unchanged') {
    db.exec("UPDATE chunks SET scope = 'general' WHERE scope IS NULL OR scope = ''");
    return inspection;
  }

  const hasChunkScope = hasColumn(db, 'chunks', 'scope');

  if (!hasChunkScope) {
    db.exec("ALTER TABLE chunks ADD COLUMN scope TEXT NOT NULL DEFAULT 'general'");
  }

  if (!hasColumn(db, 'chunks_fts', 'scope')) {
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

  return { migration: 'scope-column', status: 'changed' };
}

function migrateCacheScope(db: Database.Database): IMigrationReport {
  const inspection = inspectCacheScopeMigration(db);

  if (inspection.status === 'unchanged') {
    db.exec("UPDATE cache SET scope = 'general' WHERE scope IS NULL OR scope = ''");
    return inspection;
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

  return { migration: 'cache-scope-column', status: 'changed' };
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

function inspectScopeMigration(db: Database.Database): IMigrationReport {
  const hasChunkScope = hasColumn(db, 'chunks', 'scope');
  const hasFtsScope = hasColumn(db, 'chunks_fts', 'scope');

  if (hasChunkScope && hasFtsScope) {
    return { migration: 'scope-column', status: 'unchanged', reason: 'already-applied' };
  }

  return { migration: 'scope-column', status: 'would-migrate' };
}

function inspectCacheScopeMigration(db: Database.Database): IMigrationReport {
  if (hasColumn(db, 'cache', 'scope')) {
    return { migration: 'cache-scope-column', status: 'unchanged', reason: 'already-applied' };
  }

  return { migration: 'cache-scope-column', status: 'would-migrate' };
}

function inspectQaValidityPolicy(db: Database.Database): IMigrationReport {
  if (hasColumn(db, 'qa_questions', 'policy') && tableExists(db, 'qa_question_files')) {
    return { migration: 'qa-validity-policy', status: 'unchanged', reason: 'already-applied' };
  }
  return { migration: 'qa-validity-policy', status: 'would-migrate' };
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function hasColumn(db: Database.Database, table: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as IColumnInfo[];

  return columns.some((column) => column.name === columnName);
}
