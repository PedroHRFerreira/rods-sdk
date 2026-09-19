import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactDiff, compactStackTrace, formatContextSnippets, formatRecurringPatterns } from '../src/services/formatting-compact.js';
import { estimateTokens, reportTokenSavings, truncateToBudget } from '../src/utils/tokenization.js';

test('compact formatting reduces recurring payloads and bounds snippets', () => {
  const patterns = [{ file: 'src/handler.ts', message: 'handle async failures in promise chain with actionable context', severity: 'high' as const, count: 2 }];
  assert.ok(formatRecurringPatterns(patterns).length < JSON.stringify(patterns).length);
  const snippets = formatContextSnippets([{ path: 'src/file.ts', startLine: 10, snippet: 'a'.repeat(100) }] as never);
  assert.match(snippets, /…$/);
});

test('trace and diff compaction preserve both ends', () => {
  const lines = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n');
  for (const compacted of [compactStackTrace(lines, 20), compactDiff(lines, 20)]) {
    assert.match(compacted, /line 0/);
    assert.match(compacted, /line 99/);
    assert.match(compacted, /omitted/);
  }
});

test('token helpers estimate, truncate, and report savings', () => {
  const before = 'This is a deliberately long prompt with enough words to require a measurable token estimate.';
  const after = truncateToBudget(before, 5);
  assert.ok(estimateTokens(before) > estimateTokens(after));
  assert.ok(estimateTokens(after) <= 5);
  assert.match(reportTokenSavings(before, after), /tokens/);
});
