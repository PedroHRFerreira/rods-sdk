import type { ReviewResult } from '../services/agent-runner.js';
import type { IRecurringFindingResult } from '../services/flow-review.js';
import { formatRecurringPatterns } from '../services/formatting-compact.js';

const INITIAL_DEVELOPER = 'Implement in the current worktree. Run relevant tests and leave changes there. Task: {task}';
const CORRECTION_DEVELOPER = `Correct only outstanding review findings; do not restart implementation.
Task: {task}
Findings:
{findings}
{patterns}
Diff:
{diff}`;
const REVIEW = `Review correctness, regressions, security, and tests. Return required JSON only.
Task: {task}
Gate: {gate}
{patterns}{context}
Diff:
{diff}`;

function fillPrompt(template: string, values: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) result = result.replaceAll(`{${key}}`, value);
  return result.replace(/\n\n+/g, '\n').trim();
}

export function buildInitialDeveloperPrompt(task: string): string {
  return fillPrompt(INITIAL_DEVELOPER, { task });
}

export function buildCorrectionDeveloperPrompt(task: string, review: ReviewResult, recurring: IRecurringFindingResult | undefined, diff: string): string {
  const findings = review.findings.map((finding) => `${finding.file ?? 'general'}: ${finding.message.replace(/\s+/g, ' ').slice(0, 80)}`).join('\n');
  const patterns = formatRecurringPatterns(recurring?.patterns ?? []);
  return fillPrompt(CORRECTION_DEVELOPER, {
    task,
    findings: findings || '(no specific findings)',
    patterns: patterns ? `Patterns:\n${patterns}` : '',
    diff: diff || '(no changes)'
  });
}

export function buildReviewPrompt(task: string, gate: 'passed' | 'skipped', patterns: string, context: string, diff: string): string {
  return fillPrompt(REVIEW, {
    task,
    gate,
    patterns: patterns ? `Patterns:\n${patterns}\n` : '',
    context: context ? `Context:\n${context}\n` : '',
    diff: diff || '(no changes)'
  });
}
