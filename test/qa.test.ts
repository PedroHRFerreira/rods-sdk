import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ContextDatabase } from '../src/database/database.js';
import { getDefaultConfig } from '../src/services/config.js';
import { gitFingerprint, isQaFresh, normalizeQuestion, prepareQaValidity, qaStats, questionHash, searchQa, staleQaIds } from '../src/services/qa.js';
import type { TQaPolicy } from '../src/types/context.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rods-qa-project-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'rods-qa-storage-'));
  await fs.writeFile(path.join(root, 'README.md'), 'initial\n');
  await fs.writeFile(path.join(root, 'other.txt'), 'other\n');
  const db = new ContextDatabase({ ...getDefaultConfig(), database: path.join(storage, 'context.db') });
  return { root, db, project: db.upsertProject('fixture', root) };
}

function store(db: ContextDatabase, projectId: number, root: string, question: string, policy: TQaPolicy, files: string[] = [], summary = 'answer', tokens?: number) {
  const normalized = normalizeQuestion(question); const validity = prepareQaValidity(root, policy, files);
  return db.storeQa({ projectId, question, normalized, hash: questionHash(normalized), policy, fingerprint: validity.fingerprint, files: validity.files, summary, fullAnswer: summary, tokens });
}

test('Q&A normalizes Unicode, shares answers and defaults programmatic stores to repository', async () => {
  const { root, db, project } = await fixture();
  try {
    assert.equal(normalizeQuestion('O que É a Configuração do projeto?'), 'configuracao projeto');
    const fingerprint = gitFingerprint(root); const first = normalizeQuestion('Como configurar projeto local');
    const a = db.storeQa({ projectId: project.id, question: 'Como configurar projeto local', normalized: first, hash: questionHash(first), fingerprint, summary: 'shared', fullAnswer: 'shared' });
    const b = store(db, project.id, root, 'Como configurar projeto agora', 'repository', [], 'shared');
    assert.equal(a.policy, 'repository'); assert.equal(a.answerId, b.answerId);
  } finally { db.close(); }
});

test('conceptual remains fresh while files only reacts to declared dependencies', async () => {
  const { root, db, project } = await fixture();
  try {
    const conceptual = store(db, project.id, root, 'visao geral', 'conceptual');
    const files = store(db, project.id, root, 'config readme', 'files', ['README.md']);
    await fs.writeFile(path.join(root, 'other.txt'), 'changed elsewhere\n');
    assert.equal(isQaFresh(conceptual, root), true); assert.equal(isQaFresh(files, root), true);
    await fs.writeFile(path.join(root, 'README.md'), 'changed dependency\n');
    assert.equal(isQaFresh(conceptual, root), true); assert.equal(isQaFresh(files, root), false);
    await fs.rm(path.join(root, 'README.md'));
    assert.equal(isQaFresh(files, root), false);
    const outside = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'rods-qa-swap-')), 'outside.md'); await fs.writeFile(outside, 'changed dependency\n');
    await fs.symlink(outside, path.join(root, 'README.md'));
    assert.equal(isQaFresh(files, root), false);
  } finally { db.close(); }
});

test('file policy rejects missing, outside, directory and duplicate dependencies', async () => {
  const { root, db } = await fixture();
  try {
    await fs.mkdir(path.join(root, 'folder'));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rods-qa-outside-'));
    const outsideFile = path.join(outsideRoot, 'outside.txt'); await fs.writeFile(outsideFile, 'outside\n');
    await fs.symlink(outsideFile, path.join(root, 'outside-link'));
    await assert.rejects(async () => prepareQaValidity(root, 'files', []), /at least one/);
    await assert.rejects(async () => prepareQaValidity(root, 'files', ['missing.ts']), /does not exist/);
    await assert.rejects(async () => prepareQaValidity(root, 'files', ['folder']), /not a regular file/);
    await assert.rejects(async () => prepareQaValidity(root, 'files', ['README.md','./README.md']), /duplicate/);
    await assert.rejects(async () => prepareQaValidity(root, 'files', ['outside-link']), /outside/);
    assert.throws(() => prepareQaValidity(root, 'conceptual', ['README.md']), /only valid/);
  } finally { db.close(); }
});

test('search prefers a fresh exact or lexical candidate over stale candidates', async () => {
  const { root, db, project } = await fixture();
  try {
    const question = 'como configurar projeto'; const normalized = normalizeQuestion(question);
    db.storeQa({ projectId: project.id, question, normalized, hash: questionHash(normalized), policy: 'repository', fingerprint: 'definitely-stale', summary: 'stale' });
    const fresh = store(db, project.id, root, question, 'conceptual', [], 'fresh');
    const exact = searchQa(db, project.id, question, root); assert.equal(exact.status, 'hit'); assert.equal(exact.entry?.id, fresh.id);
    const lexical = searchQa(db, project.id, 'configurar projeto ambiente', root, 0.5); assert.equal(lexical.status, 'hit'); assert.equal(lexical.entry?.id, fresh.id);
  } finally { db.close(); }
});

test('reclassify changes validity atomically and rejects uniqueness conflicts', async () => {
  const { root, db, project } = await fixture();
  try {
    const entry = store(db, project.id, root, 'estado atual', 'repository');
    const fileValidity = prepareQaValidity(root, 'files', ['README.md']);
    const updated = db.reclassifyQa(entry.id, 'files', fileValidity.fingerprint, fileValidity.files);
    assert.equal(updated.policy, 'files'); assert.deepEqual(updated.files.map((file) => file.filePath), ['README.md']);
    await fs.writeFile(path.join(root, 'README.md'), 'new\n'); assert.equal(isQaFresh(updated, root), false);
    const conceptual = store(db, project.id, root, 'estado atual', 'conceptual');
    const conceptualValidity = prepareQaValidity(root, 'conceptual');
    assert.throws(() => db.reclassifyQa(updated.id, 'conceptual', conceptualValidity.fingerprint, []), /UNIQUE/);
    assert.equal(db.getQaById(updated.id)?.policy, 'files'); assert.equal(db.getQaById(conceptual.id)?.policy, 'conceptual');
  } finally { db.close(); }
});

test('stats exclude stale savings and prune removes stale entries plus orphan answers', async () => {
  const { root, db, project } = await fixture();
  try {
    const fresh = store(db, project.id, root, 'conceito', 'conceptual', [], 'fresh', 10);
    const stale = db.storeQa({ projectId: project.id, question: 'repo old', normalized: 'repo old', hash: questionHash('repo old'), policy: 'repository', fingerprint: 'old', summary: 'stale', tokens: 50 });
    const sharedStale = db.storeQa({ projectId: project.id, question: 'shared old', normalized: 'shared old', hash: questionHash('shared old'), policy: 'repository', fingerprint: 'old-shared', summary: 'fresh', fullAnswer: 'fresh', tokens: 10 });
    assert.equal(sharedStale.answerId, fresh.answerId);
    db.touchQa(fresh.id); db.touchQa(stale.id); db.touchQa(sharedStale.id);
    const stats = qaStats(db.listQa(project.id), root);
    assert.equal(stats.freshEntries, 1); assert.equal(stats.staleEntries, 2); assert.equal(stats.tokensSaved, 10); assert.ok(stats.staleTokensExcluded >= 50);
    const ids = staleQaIds(db.listQa(project.id), root); assert.deepEqual(new Set(ids), new Set([stale.id, sharedStale.id]));
    assert.deepEqual(staleQaIds(db.listQa(project.id), root, 9999), []);
    const dry = db.pruneQa(ids, true); assert.equal(dry.entries, 2); assert.ok(db.getQaById(stale.id));
    const pruned = db.pruneQa(ids); assert.equal(pruned.entries, 2); assert.equal(pruned.orphanAnswers, 1); assert.equal(db.getQaById(stale.id), null); assert.ok(db.getQaById(fresh.id));
    assert.equal(qaStats(db.listQa(project.id), root).staleEntries, 0);
  } finally { db.close(); }
});

test('Q&A invalidation keeps shared answers until the final question is removed', async () => {
  const { root, db, project } = await fixture();
  try {
    const one = store(db, project.id, root, 'alpha one', 'conceptual', [], 'shared');
    const two = store(db, project.id, root, 'alpha two', 'conceptual', [], 'shared');
    assert.equal(db.invalidateQa(one.id), true); assert.ok(db.getQaById(two.id)); assert.equal(db.invalidateQa(two.id), true); assert.equal(db.getQaById(two.id), null);
  } finally { db.close(); }
});
