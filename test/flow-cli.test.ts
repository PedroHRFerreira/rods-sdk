import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

async function flowFixture(): Promise<{ root: string; contextHome: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rods-flow-cli-'));
  const contextHome = await fs.mkdtemp(path.join(os.tmpdir(), 'rods-flow-context-'));
  const agent = path.join(root, 'fake-agent');
  await fs.writeFile(agent, `#!/bin/sh
sleep 0.2
if [ "$1" = "exec" ]; then
  printf 'changed by flow\n' > flow-change.txt
  printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"implementation complete"}}'
  printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":3}}'
else
  printf '%s\n' '{"result":"{\\"approved\\":true,\\"summary\\":\\"approved\\",\\"findings\\":[]}","usage":{"input_tokens":5,"output_tokens":2}}'
fi
`);
  await fs.chmod(agent, 0o755);
  await fs.mkdir(path.join(root, '.ai'), { recursive: true });
  const execution = { binary: agent, models: { simple: 'fake', medium: 'fake', high: 'fake' }, args: [], timeoutMs: 5000 };
  await fs.writeFile(path.join(root, '.ai', 'config.json'), `${JSON.stringify({
    version: 3,
    project: 'flow-cli-fixture',
    escalation: { enabled: true, mode: 'execute' },
    targets: { codex: { enabled: true, execution }, claude: { enabled: true, execution } },
    workflow: { mode: 'codex+claude', maxIterations: 1, failOnSeverity: 'high', reviewContext: false }
  }, null, 2)}\n`);
  await fs.writeFile(path.join(root, 'flow-change.txt'), 'original\n');
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
  return { root, contextHome };
}

async function runFlow(input: { root: string; contextHome: string; json: boolean }): Promise<{ stdout: string; stderr: string; progressWhileRunning: boolean; reviewWhileRunning: boolean; code: number | null }> {
  const args = ['--import', 'tsx', path.join(packageRoot, 'src/cli.ts'), 'flow', 'run', 'Update the fixture', '--mode', 'codex+claude', '--root', input.root];
  if (input.json) args.push('--json');
  const child = spawn(process.execPath, args, { cwd: packageRoot, env: { ...process.env, CONTEXT_ENGINE_HOME: input.contextHome }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let progressWhileRunning = false; let reviewWhileRunning = false;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    if (child.exitCode === null && stderr.includes('codex está desenvolvendo')) progressWhileRunning = true;
    if (child.exitCode === null && stderr.includes('claude revisou → aprovado')) reviewWhileRunning = true;
  });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { stdout, stderr, progressWhileRunning, reviewWhileRunning, code };
}

test('flow CLI streams live progress and keeps JSON stdout clean while auto-applying approval', async () => {
  const fixture = await flowFixture();
  const result = await runFlow({ ...fixture, json: true });
  assert.equal(result.code, 0);
  assert.equal(result.progressWhileRunning, true);
  assert.equal(result.reviewWhileRunning, true);
  assert.match(result.stderr, /\[iteração 1\/1\] codex está desenvolvendo…/);
  assert.match(result.stderr, /\[iteração 1\/1\] claude revisou → aprovado/);
  assert.doesNotMatch(result.stdout, /iteração|desenvolvendo|revisou/);
  const output = JSON.parse(result.stdout) as { status: string; applied: boolean; worktree: string | null; branch: string | null };
  assert.deepEqual({ status: output.status, applied: output.applied, worktree: output.worktree, branch: output.branch }, { status: 'approved', applied: true, worktree: null, branch: null });
  assert.equal(await fs.readFile(path.join(fixture.root, 'flow-change.txt'), 'utf8'), 'changed by flow\n');
  assert.equal(git(fixture.root, ['worktree', 'list', '--porcelain']).split('\n').filter((line) => line.startsWith('worktree ')).length, 1);
});

test('flow CLI text mode prints narrative summaries before technical steps', async () => {
  const fixture = await flowFixture();
  const result = await runFlow({ ...fixture, json: false });
  assert.equal(result.code, 0);
  assert.equal(result.progressWhileRunning, true);
  assert.equal(result.reviewWhileRunning, true);
  assert.match(result.stdout, /run=.* status=approved .* iterations=1/);
  assert.match(result.stdout, /  1: codex desenvolveu → claude revisou → aprovado/);
  assert.match(result.stdout, /step=develop agent=codex/);
  assert.match(result.stdout, /step=review agent=claude/);
  assert.ok(result.stdout.indexOf('1: codex desenvolveu') < result.stdout.indexOf('step=develop'));
});
