/** Approximate token accounting for compact-prompt regression tests and reports. */
export function estimateTokens(text: string): number {
  const stringMatches = text.match(/'[^']*'|"[^"]*"/g) ?? [];
  const numberMatches = text.match(/\b\d+\b/g) ?? [];
  const otherChars = text.replace(/'[^']*'|"[^"]*"|\b\d+\b/g, '').length;
  return stringMatches.length + numberMatches.length + Math.ceil(otherChars / 4);
}

export function truncateToBudget(text: string, maxTokens: number, suffix = '…'): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const target = Math.max(0, maxTokens - estimateTokens(suffix));
  let end = text.length;
  while (end > 0 && estimateTokens(text.slice(0, end)) > target) end--;
  return `${text.slice(0, end)}${suffix}`;
}

export function reportTokenSavings(before: string, after: string, label = 'Optimization'): string {
  const beforeTokens = estimateTokens(before);
  const afterTokens = estimateTokens(after);
  const percentage = beforeTokens === 0 ? 0 : Math.round(((beforeTokens - afterTokens) / beforeTokens) * 100);
  return `${label}: ${beforeTokens} → ${afterTokens} tokens (-${percentage}%)`;
}
