import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { initProject } from '../src/services/scaffold.js';

test('initProject scaffolds governance files and preserves existing files by default', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-init-'));
  const firstRun = await initProject(root);

  assert.equal(firstRun.length, 5);
  assert.ok(firstRun.every((result) => result.status === 'created'));

  const configPath = path.join(root, '.ai', 'config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
    project: string;
    execution: { mode: string; apiEnabled: boolean };
    adapters: { rtk: { enabled: boolean }; 'context-mode'?: { enabled: boolean } };
  };

  assert.equal(config.project, path.basename(root));
  assert.deepEqual(config.execution, { mode: 'cli', apiEnabled: false });
  assert.equal(config.adapters.rtk.enabled, true);
  assert.equal(config.adapters['context-mode'], undefined);
  assert.match(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), /Rods SDK Defaults/);
  assert.match(await fs.readFile(path.join(root, '.ai', 'adapters', 'rtk.md'), 'utf8'), /default rods-sdk/);
  assert.match(
    await fs.readFile(path.join(root, '.ai', 'skills', 'context-search-first', 'SKILL.md'), 'utf8'),
    /name: context-search-first/
  );

  await fs.writeFile(path.join(root, 'AGENTS.md'), 'custom');
  const secondRun = await initProject(root);
  const agentsResult = secondRun.find((result) => result.path.endsWith('AGENTS.md'));

  assert.equal(agentsResult?.status, 'skipped');
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), 'custom');

  const forcedRun = await initProject(root, { force: true });
  const forcedAgentsResult = forcedRun.find((result) => result.path.endsWith('AGENTS.md'));

  assert.equal(forcedAgentsResult?.status, 'overwritten');
  assert.match(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), /Rods SDK Defaults/);
});
