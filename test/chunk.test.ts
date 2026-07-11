import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkContent } from '../src/services/chunk.js';

test('chunkContent splits content by line limit', () => {
  const content = Array.from({ length: 121 }, (_, index) => `line ${index + 1}`).join('\n');
  const chunks = chunkContent(content, 120);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.startLine, 1);
  assert.equal(chunks[0]?.endLine, 120);
  assert.equal(chunks[1]?.startLine, 121);
  assert.equal(chunks[1]?.endLine, 121);
  assert.equal(chunks[1]?.content, 'line 121');
});

test('chunkContent preserves every line without gaps or overlaps for all families', () => {
  const cases = [
    { language: 'typescript', content: ['function one() {', '  work();', '}', '', 'function two() {', '  work();', '}', 'tail'].join('\n') },
    { language: 'python', content: ['class One:', '    def method(self):', '        work()', '', 'def next_function():', '    work()', '    work()', 'tail'].join('\n') },
    { language: 'markdown', content: ['# One', 'text', 'text', '', '# Two', 'text', 'text', 'tail'].join('\n') }
  ];

  for (const { language, content } of cases) {
    const chunks = chunkContent(content, 5, language);

    assert.equal(chunks.map((chunk) => chunk.content).join('\n'), content);
    assert.equal(chunks[0]?.startLine, 1);

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const next = chunks[index + 1];
      assert.ok(chunk);
      assert.ok(chunk.endLine - chunk.startLine + 1 <= 5);
      if (next) assert.equal(next.startLine, chunk.endLine + 1);
    }
  }
});

test('brace chunking cuts after a low-indentation block closing line', () => {
  const content = ['function example() {', '  one();', '  two();', '  three();', '}', 'const after = true;', 'tail'].join('\n');
  const chunks = chunkContent(content, 6, 'typescript');

  assert.equal(chunks[0]?.endLine, 5);
  assert.equal(chunks[0]?.content.endsWith('}'), true);
  assert.equal(chunks[1]?.startLine, 6);
});

test('indent chunking cuts before the next top-level declaration', () => {
  const content = ['class Example:', '    def one(self):', '        work()', '        more_work()', '    value = 1', '', 'def next_function():', '    work()', '    more_work()', 'tail'].join('\n');
  const chunks = chunkContent(content, 8, 'python');

  assert.equal(chunks[0]?.endLine, 6);
  assert.equal(chunks[1]?.startLine, 7);
  assert.equal(chunks[1]?.content.startsWith('def next_function():'), true);
});

test('blank chunking uses an empty line within tolerance for markdown and JSON', () => {
  for (const language of ['markdown', 'json']) {
    const content = ['one', 'two', 'three', 'four', 'five', 'six', '', 'eight', 'nine'].join('\n');
    const chunks = chunkContent(content, 8, language);

    assert.equal(chunks[0]?.endLine, 6);
    assert.equal(chunks[1]?.startLine, 7);
  }
});

test('chunkContent never exceeds chunkSize and falls back to the legacy fixed cut', () => {
  const content = Array.from({ length: 13 }, (_, index) => `line ${index + 1}`).join('\n');

  for (const language of ['typescript', 'python', 'markdown']) {
    const chunks = chunkContent(content, 5, language);

    assert.deepEqual(chunks.map(({ startLine, endLine }) => ({ startLine, endLine })), [
      { startLine: 1, endLine: 5 },
      { startLine: 6, endLine: 10 },
      { startLine: 11, endLine: 13 }
    ]);
    assert.ok(chunks.every((chunk) => chunk.endLine - chunk.startLine + 1 <= 5));
  }
});
