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

function compactTextPreservingEnds(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = '\n[… content omitted …]\n';
  if (maxChars <= marker.length) return value.slice(0, maxChars);
  const available = maxChars - marker.length;
  const headLength = Math.ceil(available / 2);
  return `${value.slice(0, headLength)}${marker}${value.slice(-(available - headLength))}`;
}

export function compactStackTrace(trace: string, maxLines = 20, maxChars = 2_000): string {
  const lines = trace.split('\n');
  const compacted = lines.length <= maxLines
    ? trace
    : [...lines.slice(0, Math.floor(maxLines / 2)), '', `[… ${lines.length - maxLines} lines omitted …]`, '', ...lines.slice(-Math.floor(maxLines / 2))].join('\n');
  return compactTextPreservingEnds(compacted, maxChars);
}

export function compactDiff(diff: string, maxLines = 200): string {
  const lines = diff.split('\n');
  if (lines.length <= maxLines) return diff;
  const half = Math.floor(maxLines / 2);
  return [...lines.slice(0, half), '', `### ${lines.length - maxLines} diff lines omitted ###`, '', ...lines.slice(-half)].join('\n');
}
