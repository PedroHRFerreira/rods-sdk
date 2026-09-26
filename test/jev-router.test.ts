import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadGovernanceConfig } from '../src/services/adapters.js';
import { routeWithJev } from '../src/services/jev-router.js';

test('Jev routing accepts confident typed answers and uses the documented endpoint', async () => {
  const config = await loadGovernanceConfig('/tmp/nonexistent-rods-jev-test');
  config.decisionRouter = { enabled: true, provider: 'vercel', minConfidence: 0.8, timeoutMs: 1000 };
  let requested = false;
  const routed = await routeWithJev({ task: 'Update a small test', config, candidates: ['codex', 'claude'], env: { AI_GATEWAY_API_KEY: 'fixture-key' }, fetcher: async (url, init) => {
    requested = true;
    assert.equal(url, 'https://ai-gateway.vercel.sh/v1/evaluate');
    const body = JSON.parse(String(init?.body)) as { questions: { developer: { criteria: Record<string, string> } } };
    assert.deepEqual(Object.keys(body.questions.developer.criteria), ['codex', 'claude']);
    return new Response(JSON.stringify({ answers: { tier: { choice: 'simple' }, developer: { choice: 'claude' } }, providerMetadata: { typesafe: { confidence: { tier: 0.94, developer: 0.9 } } }, usage: { inputTokens: 10, outputTokens: 2 } }), { status: 200 });
  } });
  assert.equal(requested, true);
  assert.deepEqual(routed.decision?.tier, 'simple');
  assert.deepEqual(routed.decision?.developer, 'claude');
  assert.equal(routed.decision?.usage.inputTokens, 10);
});

test('Jev routing fails back on missing key and uncertain confidence', async () => {
  const config = await loadGovernanceConfig('/tmp/nonexistent-rods-jev-test');
  config.decisionRouter = { enabled: true, provider: 'vercel', minConfidence: 0.8, timeoutMs: 1000 };
  assert.equal((await routeWithJev({ task: 'x', config, candidates: ['codex'], env: {} })).reason, 'missing-key');
  const result = await routeWithJev({ task: 'x', config, candidates: ['codex'], env: { AI_GATEWAY_API_KEY: 'fixture' }, fetcher: async () => new Response(JSON.stringify({ answers: { tier: { choice: 'high' }, developer: { choice: 'codex' } }, providerMetadata: { typesafe: { confidence: { tier: 0.79, developer: 0.99 } } } }), { status: 200 }) });
  assert.equal(result.decision, undefined);
  assert.equal(result.reason, 'uncertain-or-invalid');
});

test('Jev asks only for a tier when one developer is available', async () => {
  const config = await loadGovernanceConfig('/tmp/nonexistent-rods-jev-test');
  config.decisionRouter = { enabled: true, provider: 'vercel', minConfidence: 0.8, timeoutMs: 1000 };
  const routed = await routeWithJev({ task: 'Fix test', config, candidates: ['codex'], env: { AI_GATEWAY_API_KEY: 'fixture' }, fetcher: async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
    assert.deepEqual(Object.keys(body.questions), ['tier']);
    return new Response(JSON.stringify({ answers: { tier: { choice: 'medium' } }, providerMetadata: { typesafe: { confidence: { tier: 0.9 } } } }), { status: 200 });
  } });
  assert.equal(routed.decision?.developer, 'codex');
});
