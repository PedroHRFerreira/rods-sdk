import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import { ContextDatabase, type IFlowFinding } from '../src/database/database.js';
import { buildDeveloperPrompt } from '../src/commands/flow.js';
import { enforceApproval } from '../src/services/agent-runner.js';
import { getDefaultConfig } from '../src/services/config.js';
import { persistFindings, recurringFindings, recurringForFiles, reviewContextSnippets, runTestGate, sanitizeTestOutput, selectReviewDiff } from '../src/services/flow-review.js';
import { lexicalOverlap, normalizeQuestion } from '../src/services/qa.js';

test('approval enforcement reconciles claimed approval with blocking severities', () => {
  const high = { approved: true, summary: 'claimed', findings: [{ severity: 'high' as const, message: 'broken' }] };
  assert.equal(enforceApproval(high, 'high').approved, false);
  const medium = { approved: true, summary: 'claimed', findings: [{ severity: 'medium' as const, message: 'risky' }] };
  assert.equal(enforceApproval(medium, 'high').approved, true);
  assert.equal(enforceApproval(medium, 'medium').approved, false);
});

test('developer correction prompt reuses recurring patterns while initial prompt does not', () => {
  const recurring = { patterns: [{ file: 'src/a.ts', severity: 'high' as const, message: 'handle async failures', count: 2 }], findingsConsulted: 2, comparisons: 4 };
  const review = { approved: false, summary: 'fix it', findings: [{ file: 'src/a.ts', severity: 'high' as const, message: 'handle async failures' }] };
  assert.doesNotMatch(buildDeveloperPrompt('adjust flow'), /knownPatterns/);
  const correction = buildDeveloperPrompt('adjust flow', review, recurring, 'diff content');
  assert.match(correction, /knownPatterns/);
  assert.match(correction, /handle async failures/);
  assert.match(correction, /diff content/);
});

test('finishing a flow run persists its final classification tier', async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'rods-flow-tier-'));
  const databasePath = path.join(storage, 'db.sqlite');
  const db = new ContextDatabase({ ...getDefaultConfig(), database: databasePath });
  try {
    const project = db.upsertProject('project', storage);
    db.createFlowRun({ id: 'run-tier', projectId: project.id, task: 'task', mode: 'codex', tier: 'simple', status: 'running' });
    db.finishFlowRun('run-tier', { status: 'approved', tier: 'high', iterations: 1 });
  } finally { db.close(); }

  const reader = new Database(databasePath, { readonly: true });
  try {
    const run = reader.prepare('SELECT tier, status FROM flow_runs WHERE id = ?').get('run-tier') as { tier: string; status: string };
    assert.deepEqual(run, { tier: 'high', status: 'approved' });
  } finally { reader.close(); }
});

test('test gate skips when absent, passes commands, and creates a bounded synthetic finding on failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rods-gate-'));
  assert.equal(runTestGate(undefined, root).status, 'skipped');
  assert.equal(runTestGate({ command: 'test' }, root, () => ({ status: 0, stdout: 'passed', stderr: '' })).status, 'passed');
  const failed = runTestGate({ command: 'test' }, root, () => ({ status: 7, stdout: '', stderr: '\u001b[31mfailed-output\u001b[0m' })); assert.equal(failed.status, 'failed'); assert.equal(failed.finding?.severity, 'high'); assert.match(failed.finding?.message ?? '', /failed-output/);
  const sanitized = sanitizeTestOutput(`\u001b[31m${'x'.repeat(3000)}\u001b[0m`); assert.equal(sanitized.length, 2000); assert.doesNotMatch(sanitized, /\u001b/);
  assert.equal(runTestGate({ command: path.join(root, 'missing') }, root, () => ({ status: null, error: new Error('ENOENT') })).status, 'failed');
});

test('diff selection prioritizes recurring files, keeps patches whole, and declares omissions', () => {
  const patches = { 'large.ts': `diff --git a/large.ts b/large.ts\n${'x'.repeat(120)}`, 'small.ts': `diff --git a/small.ts b/small.ts\n${'y'.repeat(220)}`, 'new.ts': `diff --git a/new.ts b/new.ts\nnew file mode 100644\n${'z'.repeat(220)}` };
  const result = selectReviewDiff(patches, { 'large.ts': 20, 'small.ts': 1, 'new.ts': 1 }, { recurringFiles: ['large.ts'], budget: 400 });
  assert.equal(result.includedFiles[0], 'large.ts'); assert.ok(result.content.includes(patches['large.ts'])); assert.ok(result.omittedFiles.length > 0); assert.match(result.content, /Files omitted/);
  for (const file of result.includedFiles) assert.ok(result.content.includes(patches[file]!));
});

function finding(id: number, message: string, severity: IFlowFinding['severity'] = 'medium'): IFlowFinding {
  return { id, projectId: 1, runId: 'run', file: 'src/a.ts', severity, message, messageNorm: normalizeQuestion(message), createdAt: `2026-01-0${id}T00:00:00.000Z` };
}

test('lexical recurrence groups async paraphrases at 0.50 and reports comparison cost', () => {
  const first = finding(1, 'falta tratamento de erro na chamada assíncrona'); const second = finding(2, 'não há tratamento de erro para a chamada async', 'high'); const unrelated = finding(3, 'nome de variável pouco descritivo', 'low');
  assert.ok(lexicalOverlap(first.messageNorm, second.messageNorm) >= 0.5);
  const result = recurringFindings([first, second, unrelated]);
  assert.equal(result.patterns.length, 1); assert.equal(result.patterns[0]?.count, 2); assert.equal(result.patterns[0]?.severity, 'high'); assert.equal(result.findingsConsulted, 3); assert.equal(result.comparisons, 9);
});

test('project context search never returns chunks from another registered project', async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'rods-context-review-')); const db = new ContextDatabase({ ...getDefaultConfig(), database: path.join(storage, 'db.sqlite') });
  try {
    const one = db.upsertProject('one', path.join(storage, 'one')); const two = db.upsertProject('two', path.join(storage, 'two'));
    db.replaceChunksForPath('/one/a.ts', [{ projectId: one.id, path: '/one/a.ts', scope: 'general', kind: 'file', language: 'typescript', startLine: 1, endLine: 1, hash: 'one', content: 'function checkoutHandler() {}' }]);
    db.replaceChunksForPath('/two/b.ts', [{ projectId: two.id, path: '/two/b.ts', scope: 'general', kind: 'file', language: 'typescript', startLine: 1, endLine: 1, hash: 'two', content: 'function checkoutHandler() { unsafe(); }' }]);
    const bundle = { content: '', touchedFiles: ['src/a.ts'], includedFiles: ['src/a.ts'], omittedFiles: [], changedLines: { 'src/a.ts': 1 }, patches: { 'src/a.ts': '+function checkoutHandler() {}' } };
    const results = reviewContextSnippets(db, one.id, bundle); assert.ok(results.length > 0); assert.ok(results.every((result) => result.projectId === one.id));
  } finally { db.close(); }
});

test('finding persistence and recurrence remain isolated by project and file', async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'rods-findings-')); const db = new ContextDatabase({ ...getDefaultConfig(), database: path.join(storage, 'db.sqlite') });
  try {
    const one = db.upsertProject('one', path.join(storage, 'one')); const two = db.upsertProject('two', path.join(storage, 'two'));
    db.createFlowRun({ id: 'run-one', projectId: one.id, task: 'one', mode: 'codex', tier: 'simple', status: 'running' }); db.createFlowRun({ id: 'run-two', projectId: two.id, task: 'two', mode: 'codex', tier: 'simple', status: 'running' });
    persistFindings(db, { projectId: one.id, runId: 'run-one', findings: [{ file: 'src/a.ts', severity: 'high', message: 'falta tratamento de erro na chamada assíncrona' }, { file: 'src/a.ts', severity: 'medium', message: 'não há tratamento de erro para a chamada async' }] });
    persistFindings(db, { projectId: two.id, runId: 'run-two', findings: [{ file: 'src/a.ts', severity: 'high', message: 'falta tratamento de erro na chamada assíncrona' }] });
    const result = recurringForFiles(db, one.id, ['src/a.ts']); assert.equal(result.patterns.length, 1); assert.equal(result.patterns[0]?.count, 2); assert.equal(result.findingsConsulted, 2);
    assert.equal(recurringForFiles(db, two.id, ['src/a.ts']).patterns.length, 0); assert.equal(recurringForFiles(db, one.id, ['src/other.ts']).findingsConsulted, 0);
  } finally { db.close(); }
});
