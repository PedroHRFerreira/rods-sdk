import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runAgent } from '../src/services/agent-runner.js';

async function fakeAgent(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rods-fake-agent-')); const file = path.join(root, 'agent');
  await fs.writeFile(file, `#!/bin/sh
claude=false
gemini=false
review=false
invalid=false
no_usage=false
mode=''
previous=''
for arg in "$@"; do
  [ "$arg" = "--output-format" ] && claude=true
  [ "$arg" = "--approval-mode" ] && gemini=true
  [ "$arg" = "--output-schema" ] && review=true
  [ "$arg" = "--json-schema" ] && review=true
  [ "$arg" = "--invalid-output" ] && invalid=true
  [ "$arg" = "--no-usage" ] && no_usage=true
  [ "$previous" = "--approval-mode" ] && mode="$arg"
  case "$arg" in *'"approved"'*) review=true ;; esac
  previous="$arg"
done
if [ "$gemini" = true ]; then
  if [ "$invalid" = true ]; then response='not-json'; elif [ "$mode" = "plan" ] && [ "$review" = true ]; then response='{\\"approved\\":true,\\"summary\\":\\"ok\\",\\"findings\\":[]}'; else response="done:$mode"; fi
  if [ "$no_usage" = true ]; then printf '{"response":"%s","stats":{"models":{}}}\n' "$response"; else printf '{"response":"%s","stats":{"models":{"pro":{"tokens":{"prompt":5,"candidates":2}},"flash":{"tokens":{"prompt":7,"candidates":3}}}}}\n' "$response"; fi
elif [ "$claude" = true ]; then
  printf '%s\n' '{"result":"done","usage":{"input_tokens":7,"output_tokens":3}}'
else
  printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"approved\\":true,\\"summary\\":\\"ok\\",\\"findings\\":[]}"}}'
  printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":3}}'
fi
`);
  await fs.chmod(file, 0o755); return file;
}

test('agent adapters select configured models and parse structured review and usage', async () => {
  const binary = await fakeAgent(); const config = { binary, models: { simple: 'small', medium: 'medium', high: 'large' }, args: [], timeoutMs: 5000 };
  const codex = await runAgent({ agent: 'codex', config, tier: 'simple', cwd: os.tmpdir(), prompt: 'review', review: true });
  assert.equal(codex.review?.approved, true); assert.equal(codex.inputTokens, 7); assert.equal(codex.outputTokens, 3);
  const claude = await runAgent({ agent: 'claude', config, tier: 'high', cwd: os.tmpdir(), prompt: 'work' });
  assert.equal(claude.output, 'done'); assert.equal(claude.inputTokens, 7);
});

test('gemini uses role-specific approval modes and parses response and multi-model usage', async () => {
  const binary = await fakeAgent(); const config = { binary, models: { simple: 'flash', medium: 'pro', high: 'pro' }, args: [], timeoutMs: 5000 };
  const developer = await runAgent({ agent: 'gemini', config, tier: 'simple', cwd: os.tmpdir(), prompt: 'work' });
  assert.equal(developer.output, 'done:auto_edit'); assert.equal(developer.inputTokens, 12); assert.equal(developer.outputTokens, 5);
  const reviewer = await runAgent({ agent: 'gemini', config, tier: 'high', cwd: os.tmpdir(), prompt: 'review', review: true });
  assert.equal(reviewer.review?.approved, true); assert.equal(reviewer.inputTokens, 12); assert.equal(reviewer.outputTokens, 5);
  const noUsage = await runAgent({ agent: 'gemini', config: { ...config, args: ['--no-usage'] }, tier: 'simple', cwd: os.tmpdir(), prompt: 'work' });
  assert.equal(noUsage.inputTokens, null); assert.equal(noUsage.outputTokens, null);
});

test('gemini rejects invalid structured reviews', async () => {
  const binary = await fakeAgent(); const config = { binary, models: { simple: 'flash', medium: 'pro', high: 'pro' }, args: ['--invalid-output'], timeoutMs: 5000 };
  await assert.rejects(() => runAgent({ agent: 'gemini', config, tier: 'simple', cwd: os.tmpdir(), prompt: 'review', review: true }), /Invalid structured review from gemini/);
});

test('agent adapter rejects missing models and unsafe args', async () => {
  const binary = await fakeAgent();
  await assert.rejects(() => runAgent({ agent: 'codex', config: { binary, models: { simple: '', medium: '', high: '' }, args: [], timeoutMs: 5000 }, tier: 'simple', cwd: os.tmpdir(), prompt: 'x' }), /No model configured/);
  for (const arg of ['--model','--model=override','--prompt','--prompt=override','-p','--approval-mode','--approval-mode=yolo','--yolo','--yolo=true','-y','--sandbox','--sandbox=true','-s']) {
    await assert.rejects(() => runAgent({ agent: 'gemini', config: { binary, models: { simple: 'x', medium: 'x', high: 'x' }, args: [arg], timeoutMs: 5000 }, tier: 'simple', cwd: os.tmpdir(), prompt: 'x' }), /unsafe option/);
  }
});
