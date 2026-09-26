import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createPlanningSnapshot, runInitWizard, runPlanningAgent, validateSkillProposal } from '../src/services/skill-planner.js';
import { upgradeProject } from '../src/services/scaffold.js';

function proposal() {
  const names = ['context-search-first', 'review', 'architecture', 'quality'];
  return { plan: 'Adapt the four essential skills to this repository.', skills: names.map((name) => ({
    name, description: `${name} for this repository`,
    content: `---\nname: ${name}\ndescription: ${name} for this repository\n---\n\n# ${name}\n\nRead package.json and run npm test when checking this project.\n`
  })) };
}

test('planner snapshot excludes credential files and keeps project evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rods-planner-snapshot-'));
  await fs.writeFile(path.join(root, 'package.json'), '{"scripts":{"test":"node --test"}}');
  await fs.writeFile(path.join(root, '.env'), 'TOKEN=secret');
  await fs.writeFile(path.join(root, 'private.pem'), 'secret');
  const snapshot = await createPlanningSnapshot(root);
  try {
    assert.deepEqual(snapshot.files, ['package.json']);
    assert.match(await fs.readFile(path.join(snapshot.directory, 'package.json'), 'utf8'), /node --test/);
  } finally { await snapshot.cleanup(); }
});

test('interactive init previews a selected proposal then applies it in one run', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rods-planner-init-'));
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"sample"}');
  const answers = ['', 'test-model', 'Focus on tests', 'a', 's'];
  const output: string[] = [];
  let calls = 0;
  const result = await runInitWizard(root, {
    ask: async () => answers.shift() ?? '', write: (message) => { output.push(message); }
  }, {
    availableAgents: ['codex'],
    planningAgent: async () => {
      calls++;
      if (calls === 1) return JSON.stringify({ findings: 'Node project', question: 'What matters most?', plan: null });
      if (calls === 2) return JSON.stringify({ findings: 'Tests matter', question: null, plan: proposal().plan });
      return JSON.stringify(proposal());
    }
  });
  assert.equal(result.status, 'applied');
  assert.equal(calls, 3);
  assert.ok(output.some((line) => line.includes('Plano proposto')));
  assert.equal(await fs.readFile(path.join(root, '.ai', 'skills', 'quality', 'SKILL.md'), 'utf8'), proposal().skills[3].content);
  await assert.rejects(fs.access(path.join(root, '.ai', 'skills', 'visual-check', 'SKILL.md')));
  const agents = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(agents, /visual-check\/SKILL/);
  const config = JSON.parse(await fs.readFile(path.join(root, '.ai', 'config.json'), 'utf8')) as { selectedSkills: string[] };
  assert.deepEqual(config.selectedSkills, proposal().skills.map((skill) => skill.name));
  await upgradeProject(root);
  assert.equal(await fs.readFile(path.join(root, '.ai', 'skills', 'quality', 'SKILL.md'), 'utf8'), proposal().skills[3].content);
});

test('cancelling the init plan leaves the project unchanged', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rods-planner-cancel-'));
  const answers = ['', 'test-model', 'c'];
  const result = await runInitWizard(root, { ask: async () => answers.shift() ?? '', write: () => {} }, {
    availableAgents: ['codex'], planningAgent: async () => JSON.stringify({ findings: 'Generic project', plan: 'Use four core skills.', question: null })
  });
  assert.equal(result.status, 'cancelled');
  await assert.rejects(fs.access(path.join(root, '.ai')));
});

test('proposal validation rejects invalid paths and missing core skills', () => {
  assert.throws(() => validateSkillProposal({ plan: 'bad', skills: [{ name: '../bad', description: 'bad', content: '---\nname: bad\n---\n' }] }));
  assert.throws(() => validateSkillProposal({ plan: 'bad', skills: proposal().skills.slice(1) }));
});

test('planning agent reads structured Codex output from a read-only CLI invocation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rods-planner-cli-'));
  const binary = path.join(root, 'fake-codex');
  await fs.writeFile(binary, `#!/bin/sh
printf '%s\\n' "$@" > args.txt
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"plan\\":\\"ok\\"}"}}'
`);
  await fs.chmod(binary, 0o755);
  const result = await runPlanningAgent({ agent: 'codex', model: 'fixture', cwd: root, prompt: 'plan', binary });
  assert.equal(result, '{"plan":"ok"}');
  const args = (await fs.readFile(path.join(root, 'args.txt'), 'utf8')).split('\n');
  assert.ok(args.includes('read-only'));
  assert.ok(args.includes('--skip-git-repo-check'));
});
