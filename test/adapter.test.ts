import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { doctorAdapters, enableAdapter, listAdapters, syncAdapters } from '../src/services/adapters.js';
import { initProject } from '../src/services/scaffold.js';

test('adapter catalog excludes context-mode and keeps rtk as the default adapter', () => {
  const adapters = listAdapters();

  assert.deepEqual(
    adapters.map((adapter) => adapter.name),
    ['rtk', 'claude-mem', 'caveman']
  );
});

test('enableAdapter updates .ai/config.json and writes the adapter note', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-adapter-enable-'));
  await initProject(root);

  const result = await enableAdapter(root, 'claude-mem');
  const config = JSON.parse(await fs.readFile(path.join(root, '.ai', 'config.json'), 'utf8')) as {
    adapters: { rtk: { enabled: boolean }; 'claude-mem': { enabled: boolean } };
  };

  assert.equal(result.adapter, 'claude-mem');
  assert.equal(config.adapters.rtk.enabled, true);
  assert.equal(config.adapters['claude-mem'].enabled, true);
  assert.match(await fs.readFile(path.join(root, '.ai', 'adapters', 'claude-mem.md'), 'utf8'), /npx claude-mem install/);
});

test('syncAdapters copies .ai skills to the Codex .agents skills directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-adapter-sync-'));
  await initProject(root);

  const result = await syncAdapters(root, 'codex');
  const syncedSkill = await fs.readFile(
    path.join(root, '.agents', 'skills', 'context-search-first', 'SKILL.md'),
    'utf8'
  );

  assert.equal(result.target, 'codex');
  assert.equal(result.files.length, 1);
  assert.match(syncedSkill, /Context Search First/);
});

test('doctorAdapters reports binary checks and Codex configuration signals', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-adapter-doctor-'));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-adapter-bin-'));
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'context-adapter-codex-'));
  await initProject(root);
  await enableAdapter(root, 'rtk');

  const rtkPath = path.join(binDir, 'rtk');
  await fs.writeFile(
    rtkPath,
    [
      '#!/bin/sh',
      'case "$1" in',
      "  --version) echo 'rtk 0.28.2' ;;",
      "  gain) echo 'saved=1200' ;;",
      '  *) exit 1 ;;',
      'esac',
      ''
    ].join('\n')
  );
  await fs.chmod(rtkPath, 0o755);

  const reports = await doctorAdapters(root, {
    codexHome,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`
    }
  });
  const rtk = reports.find((report) => report.name === 'rtk');

  assert.equal(rtk?.enabled, true);
  assert.equal(rtk?.installed, true);
  assert.equal(rtk?.version, 'rtk 0.28.2');
  assert.equal(rtk?.checks.length, 2);
  assert.equal(reports.some((report) => report.name === 'context-mode'), false);
});
