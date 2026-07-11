import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runAgent } from '../src/services/agent-runner.js';

async function fakeAgent(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rods-fake-agent-')); const file = path.join(root, 'agent');
  await fs.writeFile(file, `#!/bin/sh\nclaude=false\nreview=false\nfor arg in "$@"; do\n  [ "$arg" = "--output-format" ] && claude=true\n  [ "$arg" = "--output-schema" ] && review=true\n  [ "$arg" = "--json-schema" ] && review=true\ndone\nif [ "$claude" = true ]; then\n  printf '%s\\n' '{"result":"done","usage":{"input_tokens":7,"output_tokens":3}}'\nelse\n  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"approved\\":true,\\"summary\\":\\"ok\\",\\"findings\\":[]}"}}'\n  printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":3}}'\nfi\n`);
  await fs.chmod(file, 0o755); return file;
}

test('agent adapters select configured models and parse structured review and usage', async () => {
  const binary = await fakeAgent(); const config = { binary, models: { simple: 'small', medium: 'medium', high: 'large' }, args: [], timeoutMs: 5000 };
  const codex = await runAgent({ agent: 'codex', config, tier: 'simple', cwd: os.tmpdir(), prompt: 'review', review: true });
  assert.equal(codex.review?.approved, true); assert.equal(codex.inputTokens, 7); assert.equal(codex.outputTokens, 3);
  const claude = await runAgent({ agent: 'claude', config, tier: 'high', cwd: os.tmpdir(), prompt: 'work' });
  assert.equal(claude.output, 'done'); assert.equal(claude.inputTokens, 7);
});

test('agent adapter rejects missing models and unsafe args', async () => {
  const binary = await fakeAgent();
  await assert.rejects(() => runAgent({ agent: 'codex', config: { binary, models: { simple: '', medium: '', high: '' }, args: [], timeoutMs: 5000 }, tier: 'simple', cwd: os.tmpdir(), prompt: 'x' }), /No model configured/);
  await assert.rejects(() => runAgent({ agent: 'codex', config: { binary, models: { simple: 'x', medium: 'x', high: 'x' }, args: ['--model'], timeoutMs: 5000 }, tier: 'simple', cwd: os.tmpdir(), prompt: 'x' }), /unsafe option/);
  await assert.rejects(() => runAgent({ agent: 'codex', config: { binary, models: { simple: 'x', medium: 'x', high: 'x' }, args: ['--model=override'], timeoutMs: 5000 }, tier: 'simple', cwd: os.tmpdir(), prompt: 'x' }), /unsafe option/);
});
