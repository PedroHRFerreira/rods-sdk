import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getMissingBuildWarning } from '../src/commands/init.js';

test('package.json includes prepare build script for git installs', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  assert.equal(packageJson.scripts.prepare, 'npm run build');
});

test('getMissingBuildWarning reports pnpm lifecycle blocking guidance when dist is absent', async () => {
  const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'context-package-root-'));
  const warning = await getMissingBuildWarning({ npm_config_user_agent: 'pnpm/9.0.0' }, packageRoot);

  assert.match(warning ?? '', /pnpm approve-builds/);
  assert.match(warning ?? '', /pnpm.onlyBuiltDependencies/);
});
