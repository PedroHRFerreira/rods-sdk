import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ContextDatabase } from '../src/database/database.js';
import { loadConfig } from '../src/services/config.js';
import { IndexerService } from '../src/services/indexer.js';

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
