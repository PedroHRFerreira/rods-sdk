import type { IRecurringPattern } from './flow-review.js';
import type { ISearchResult } from '../types/context.js';

/** Compact representations used in agent prompts and bounded diagnostics. */
export function formatRecurringPatterns(patterns: IRecurringPattern[]): string {
  if (!patterns.length) return '';
  const severityMap = { high: 'H', medium: 'M', low: 'L' } as const;
  return patterns.map((pattern) => {
    const message = pattern.message.replace(/\s+/g, ' ').slice(0, 60).trim();
    return `${pattern.file}|${message}|${pattern.count}x${severityMap[pattern.severity]}`;
  }).join('\n');
}

export function formatContextSnippets(results: ISearchResult[], maxCharsPerSnippet = 60): string {
  return results.map((result) => {
    const source = result.snippet.replace(/\s+/g, ' ').trim();
    const snippet = source.slice(0, maxCharsPerSnippet);
    return `${result.path}:${result.startLine} ${snippet}${source.length > maxCharsPerSnippet ? '…' : ''}`;
  }).join('\n');
}

export function compactStackTrace(trace: string, maxLines = 20): string {
  const lines = trace.split('\n');
  if (lines.length <= maxLines) return trace;
  const half = Math.floor(maxLines / 2);
  return [...lines.slice(0, half), '', `[… ${lines.length - maxLines} lines omitted …]`, '', ...lines.slice(-half)].join('\n');
}

export function compactDiff(diff: string, maxLines = 200): string {
  const lines = diff.split('\n');
  if (lines.length <= maxLines) return diff;
  const half = Math.floor(maxLines / 2);
  return [...lines.slice(0, half), '', `### ${lines.length - maxLines} diff lines omitted ###`, '', ...lines.slice(-half)].join('\n');
}
