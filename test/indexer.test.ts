import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ContextDatabase } from '../src/database/database.js';
import { loadConfig } from '../src/services/config.js';
import { IndexerService } from '../src/services/indexer.js';
import { sha256 } from '../src/utils/hash.js';

test('IndexerService ingests, searches and skips unchanged files', async () => {
  const storageHome = await fs.mkdtemp(path.join(os.tmpdir(), 'context-home-'));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'context-project-'));
  process.env.CONTEXT_ENGINE_HOME = storageHome;

  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.mkdir(path.join(projectRoot, 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, '.gitignore'), 'ignored-file.md\n');
  await fs.writeFile(path.join(projectRoot, 'ignored-file.md'), 'ignored-token\n');
  await fs.writeFile(path.join(projectRoot, 'node_modules', 'pkg', 'index.js'), 'ignored-token\n');

  const sourceContent = Array.from({ length: 125 }, (_, index) =>
    index === 122 ? 'needle-token appears here' : `line ${index + 1}`
  ).join('\n');
  const sourcePath = path.join(projectRoot, 'src', 'large.ts');
  await fs.writeFile(sourcePath, sourceContent);

  const config = loadConfig();
  const db = new ContextDatabase(config);

  try {
    const indexer = new IndexerService(db, config);
    const summary = await indexer.ingestPath(projectRoot);

    assert.equal(summary.failed, 0);
    assert.ok(summary.indexed >= 1);
    assert.ok(summary.chunks >= 2);

    const results = db.search('needle-token', 8);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.path, sourcePath);
    assert.equal(results[0]?.scope, 'general');
    assert.equal(results[0]?.startLine, 121);
    assert.equal(db.search('ignored-token', 8).length, 0);

    const statsBefore = db.stats();
    const secondSummary = await indexer.ingestPath(sourcePath);
    const statsAfter = db.stats();

    assert.equal(secondSummary.skipped, 1);
    assert.equal(statsAfter.chunks, statsBefore.chunks);
  } finally {
    db.close();
    delete process.env.CONTEXT_ENGINE_HOME;
  }
});

test('IndexerService isolates search results by scope', async () => {
  const storageHome = await fs.mkdtemp(path.join(os.tmpdir(), 'context-home-scope-'));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'context-project-scope-'));
  process.env.CONTEXT_ENGINE_HOME = storageHome;

  const sourcePath = path.join(projectRoot, 'review.md');
  await fs.writeFile(sourcePath, 'review-only-token\n');

  const config = loadConfig();
  const db = new ContextDatabase(config);

  try {
    const indexer = new IndexerService(db, config);
    const summary = await indexer.ingestPath(sourcePath, { scope: 'review' });

    assert.equal(summary.failed, 0);
    assert.equal(db.searchScoped('review-only-token', 8, 'general').length, 0);

    const reviewResults = db.searchScoped('review-only-token', 8, 'review');
    assert.equal(reviewResults.length, 1);
    assert.equal(reviewResults[0]?.scope, 'review');
  } finally {
    db.close();
    delete process.env.CONTEXT_ENGINE_HOME;
  }
});

test('IndexerService reprocesses a legacy cache entry once after the chunk algorithm upgrade', async () => {
  const storageHome = await fs.mkdtemp(path.join(os.tmpdir(), 'context-home-cache-version-'));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'context-project-cache-version-'));
  process.env.CONTEXT_ENGINE_HOME = storageHome;

  const sourcePath = path.join(projectRoot, 'legacy.ts');
  const sourceContent = 'const legacy = true;\n';
  await fs.writeFile(sourcePath, sourceContent);

  const config = loadConfig();
  const db = new ContextDatabase(config);

  try {
    db.setCache(`file:${sourcePath}:file`, sha256(Buffer.from(sourceContent)), 'general');
    const indexer = new IndexerService(db, config);

    const firstSummary = await indexer.ingestPath(sourcePath);
    assert.equal(firstSummary.indexed, 1);
    assert.equal(firstSummary.skipped, 0);

    const secondSummary = await indexer.ingestPath(sourcePath);
    assert.equal(secondSummary.indexed, 0);
    assert.equal(secondSummary.skipped, 1);
  } finally {
    db.close();
    delete process.env.CONTEXT_ENGINE_HOME;
  }
});

test('IndexerService detects the project root when ingesting a single file', async () => {
  const storageHome = await fs.mkdtemp(path.join(os.tmpdir(), 'context-home-root-detect-'));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'context-project-root-detect-'));
  process.env.CONTEXT_ENGINE_HOME = storageHome;

  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, '.gitignore'), 'src/ignored.ts\n');

  const sourcePath = path.join(projectRoot, 'src', 'ignored.ts');
  await fs.writeFile(sourcePath, 'ignored-by-root-detection\n');

  const config = loadConfig();
  const db = new ContextDatabase(config);

  try {
    const indexer = new IndexerService(db, config);
    const summary = await indexer.ingestPath(sourcePath);

    assert.equal(summary.indexed, 0);
    assert.equal(summary.ignored, 1);
    assert.equal(db.search('ignored-by-root-detection', 8).length, 0);
  } finally {
    db.close();
    delete process.env.CONTEXT_ENGINE_HOME;
  }
});

test('loadConfig resolves relative CONTEXT_ENGINE_HOME from the provided project root', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'context-home-relative-root-'));
  const projectRoot = path.join(workspaceRoot, 'app');
  process.env.CONTEXT_ENGINE_HOME = '.context-engine';

  await fs.mkdir(projectRoot, { recursive: true });

  const config = loadConfig(projectRoot);
  const db = new ContextDatabase(config, { baseDir: projectRoot });

  try {
    assert.equal(db.databasePath, path.join(projectRoot, '.context-engine', 'db', 'context.db'));
  } finally {
    db.close();
    delete process.env.CONTEXT_ENGINE_HOME;
  }
});

test('ContextDatabase error includes the database path it attempted to open', async () => {
  const storageHome = await fs.mkdtemp(path.join(os.tmpdir(), 'context-home-open-error-'));
  const blockingPath = path.join(storageHome, 'db', 'context.db');
  process.env.CONTEXT_ENGINE_HOME = storageHome;

  await fs.mkdir(path.dirname(blockingPath), { recursive: true });
  await fs.mkdir(blockingPath, { recursive: true });

  const config = loadConfig();

  assert.throws(
    () => new ContextDatabase(config),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('Failed to open Context Engine database at') &&
      error.message.includes(blockingPath)
  );

  delete process.env.CONTEXT_ENGINE_HOME;
});
