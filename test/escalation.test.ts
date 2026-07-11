import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { classifyTask, createModelAdvice, loadComplexityPolicy } from '../src/escalation/index.js';
import { createHookResponse } from '../src/services/hook-runner.js';

async function policyRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rods-escalation-'));
  await fs.mkdir(path.join(root, '.ai', 'policies'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.ai', 'policies', 'complexity.md'),
    `---\nsimple:\n  maxFiles: 2\n  maxLayers: 1\nmedium:\n  maxFiles: 7\n  maxLayers: 2\nhigh:\n  minFiles: 8\n  minLayers: 3\nepicPhrases:\n  - sistema de\ndependencyRaisesTo: medium\nlayers:\n  - src\n  - backend\n---\n`
  );
  return root;
}

test('classifyTask applies simple, medium, and high golden cases', async () => {
  const root = await policyRoot();
  const policy = await loadComplexityPolicy(root);
  assert.equal(classifyTask({ task: 'ajuste pontual', root, files: ['src/a.ts'], policy }).level, 'simple');
  assert.equal(classifyTask({ task: 'alterar fluxo', root, files: ['src/a.ts', 'backend/b.ts', 'src/c.ts'], policy }).level, 'medium');
  const high = classifyTask({ task: 'implementar um sistema de checkout completo', root, files: ['src/a.ts'], policy });
  assert.equal(high.level, 'high');
  assert.equal(high.planningRequired, true);
  assert.equal(createModelAdvice(high).changesConfiguration, false);
});

test('pre-execution classification ignores file signals without forcing human review', async () => {
  const root = await policyRoot();
  const policy = await loadComplexityPolicy(root);
  const unrelatedFiles = ['src/a.ts', 'src/b.ts', 'backend/c.ts'];
  const preExecution = classifyTask({ task: 'ajuste pontual', root, files: unrelatedFiles, policy, preExecution: true });
  assert.equal(preExecution.level, 'simple');
  assert.equal(preExecution.needsHumanReview, false);
  assert.equal(preExecution.estimatedFiles, 0);

  const standalone = classifyTask({ task: 'ajuste pontual', root, files: unrelatedFiles, policy });
  assert.equal(standalone.level, 'medium');
  assert.equal(standalone.estimatedFiles, 3);
});

test('pre-execution classification never reads an unrelated repository diff', async () => {
  const root = await policyRoot();
  const policy = await loadComplexityPolicy(root);
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'rods-fake-git-'));
  const calls = path.join(bin, 'calls');
  const git = path.join(bin, 'git');
  await fs.writeFile(git, `#!/bin/sh\nprintf '%s\\n' "$PWD" >> ${JSON.stringify(calls)}\nprintf '%s\\n' src/a.ts src/b.ts backend/c.ts\n`);
  await fs.chmod(git, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
  try {
    assert.equal(classifyTask({ task: 'ajuste pontual', root, policy, preExecution: true }).level, 'simple');
    await assert.rejects(() => fs.readFile(calls, 'utf8'), /ENOENT/);
    assert.equal(classifyTask({ task: 'ajuste pontual', root, policy }).level, 'medium');
    assert.equal((await fs.readFile(calls, 'utf8')).trim(), root);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test('pre-execution classification keeps textual epic and dependency signals', async () => {
  const root = await policyRoot();
  const policy = await loadComplexityPolicy(root);
  assert.equal(classifyTask({ task: 'implementar um sistema de checkout', root, policy, preExecution: true }).level, 'high');
  assert.equal(classifyTask({ task: 'executar npm install para nova dependência', root, policy, preExecution: true }).level, 'medium');
});

test('invalid complexity policy fails clearly', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rods-invalid-policy-'));
  await fs.mkdir(path.join(root, '.ai', 'policies'), { recursive: true });
  await fs.writeFile(path.join(root, '.ai', 'policies', 'complexity.md'), '# missing frontmatter\n');
  await assert.rejects(() => loadComplexityPolicy(root), /YAML frontmatter/);
});

test('hook response gives a visible high-scope opt-out without changing configuration', async () => {
  const root = await policyRoot();
  const configPath = path.join(root, '.ai', 'config.json');
  await fs.writeFile(configPath, '{"version":2,"model":"balanced"}\n');
  const before = await fs.readFile(configPath, 'utf8');
  const response = await createHookResponse('codex', {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'implementar um sistema de checkout completo',
    cwd: root
  });
  assert.match(response?.hookSpecificOutput.additionalContext ?? '', /ignorar planejamento do rods/);
  assert.match(response?.systemMessage ?? '', /ALTO/);
  assert.equal(await fs.readFile(configPath, 'utf8'), before);
});

test('non prompt hook events are fail-open', async () => {
  const response = await createHookResponse('claude', { hook_event_name: 'PostToolUse', prompt: 'tudo' });
  assert.equal(response, undefined);
});
