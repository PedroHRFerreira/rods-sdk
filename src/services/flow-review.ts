import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ContextDatabase, IFlowFinding } from '../database/database.js';
import type { ISearchResult } from '../types/context.js';
import type { ReviewResult } from './agent-runner.js';
import type { IWorkflowTestCommand } from './adapters.js';
import { lexicalOverlap, normalizeQuestion } from './qa.js';

export const REVIEW_DIFF_BUDGET = 50_000;
export const FINDING_OVERLAP_THRESHOLD = 0.5;

export interface ITestGateResult {
  status: 'skipped' | 'passed' | 'failed';
  durationMs: number;
  output?: string;
  finding?: ReviewResult['findings'][number];
}

export type TestGateExecutor = (command: string, args: string[], options: { cwd: string; encoding: 'utf8'; shell: false; timeout: number; maxBuffer: number }) => { stdout?: string; stderr?: string; status: number | null; error?: Error };

export interface IDiffBundle {
  content: string;
  touchedFiles: string[];
  includedFiles: string[];
  omittedFiles: string[];
  changedLines: Record<string, number>;
  patches: Record<string, string>;
}

export interface IRecurringPattern {
  file: string;
  severity: 'low' | 'medium' | 'high';
  message: string;
  count: number;
}

export interface IRecurringFindingResult {
  patterns: IRecurringPattern[];
  findingsConsulted: number;
  comparisons: number;
}

const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function sanitizeTestOutput(value: string): string {
  return value.replace(ANSI, '').trim().slice(-2000);
}

export function runTestGate(command: IWorkflowTestCommand | undefined, cwd: string, executor: TestGateExecutor = spawnSync as TestGateExecutor): ITestGateResult {
  if (!command) return { status: 'skipped', durationMs: 0 };
  if (!command.command.trim()) throw new Error('workflow.testCommand.command cannot be empty');
  const timeoutMs = command.timeoutMs ?? 600_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) throw new Error('workflow.testCommand.timeoutMs must be an integer >= 1000');
  const started = Date.now();
  const result = executor(command.command, command.args ?? [], { cwd, encoding: 'utf8', shell: false, timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 });
  const output = sanitizeTestOutput(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (!result.error && result.status === 0) return { status: 'passed', durationMs: Date.now() - started, output };
  const reason = result.error?.message ?? `exit code ${result.status ?? 'unknown'}`;
  return { status: 'failed', durationMs: Date.now() - started, output, finding: { severity: 'high', message: `testCommand failed (${reason})${output ? `:\n${output}` : ''}` } };
}

function git(cwd: string, args: string[], allowedCodes = [0]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (!allowedCodes.includes(result.status ?? -1)) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

function posix(value: string): string { return value.split(path.sep).join('/').replace(/^\.\//, ''); }

function patchForFile(cwd: string, file: string, untracked: boolean): string {
  if (!untracked) return git(cwd, ['diff','--no-ext-diff','--binary','HEAD','--',file]);
  const absolute = path.join(cwd, file);
  return git(cwd, ['diff','--no-index','--binary','--','/dev/null',absolute], [0, 1]).replaceAll(absolute, file);
}

export function buildReviewDiff(cwd: string, options: { priorityFiles?: string[]; recurringFiles?: string[]; budget?: number } = {}): IDiffBundle {
  const tracked = git(cwd, ['diff','--name-only','HEAD']).split(/\r?\n/).filter(Boolean).map(posix);
  const untracked = git(cwd, ['ls-files','--others','--exclude-standard']).split(/\r?\n/).filter(Boolean).map(posix);
  const touchedFiles = [...new Set([...tracked, ...untracked])];
  const untrackedSet = new Set(untracked); const patches: Record<string, string> = {}; const changedLines: Record<string, number> = {};
  for (const file of touchedFiles) { const patch = patchForFile(cwd, file, untrackedSet.has(file)); patches[file] = patch; changedLines[file] = patch.split(/\r?\n/).filter((line) => /^[+-](?![+-])/.test(line)).length; }
  return selectReviewDiff(patches, changedLines, options);
}

export function selectReviewDiff(patches: Record<string, string>, changedLines: Record<string, number>, options: { priorityFiles?: string[]; recurringFiles?: string[]; budget?: number } = {}): IDiffBundle {
  const touchedFiles = Object.keys(patches); const priority = new Set((options.priorityFiles ?? []).map(posix)); const recurring = new Set((options.recurringFiles ?? []).map(posix));
  const ordered = [...touchedFiles].sort((left, right) => Number(priority.has(right)) - Number(priority.has(left)) || Number(recurring.has(right)) - Number(recurring.has(left)) || patches[left]!.length - patches[right]!.length || left.localeCompare(right));
  const budget = options.budget ?? REVIEW_DIFF_BUDGET; const includedFiles: string[] = []; const omittedFiles: string[] = []; const sections: string[] = []; let used = 0;
  for (const file of ordered) { const section = `\n### ${file} (${changedLines[file]} changed lines)\n${patches[file]}`; if (used + section.length <= budget) { sections.push(section); includedFiles.push(file); used += section.length; } else omittedFiles.push(file); }
  const render = () => { const notice = omittedFiles.length ? `\nFiles omitted from the diff because of the character budget: ${omittedFiles.join(', ')}. Inspect them directly in the read-only worktree before approving when necessary.\n` : ''; return `${sections.join('')}\n${notice}`.trim(); };
  let content = render();
  while (content.length > budget && includedFiles.length) { const removed = includedFiles.pop()!; sections.pop(); omittedFiles.unshift(removed); content = render(); }
  if (content.length > budget) throw new Error(`Diff omission manifest exceeds the ${budget}-character review budget`);
  return { content, touchedFiles, includedFiles, omittedFiles, changedLines, patches };
}

function severityRank(value: IFlowFinding['severity']): number { return value === 'high' ? 3 : value === 'medium' ? 2 : 1; }

export function recurringFindings(findings: IFlowFinding[], limit = 3): IRecurringFindingResult {
  const eligible = findings.filter((finding) => finding.file && finding.messageNorm);
  let comparisons = 0;
  const candidates = eligible.map((finding) => {
    let count = 0;
    for (const other of eligible) { if (other.file !== finding.file) continue; comparisons++; if (lexicalOverlap(finding.messageNorm, other.messageNorm) >= FINDING_OVERLAP_THRESHOLD) count++; }
    return { finding, count };
  }).filter((candidate) => candidate.count >= 2).sort((left, right) => right.count - left.count || severityRank(right.finding.severity) - severityRank(left.finding.severity) || right.finding.createdAt.localeCompare(left.finding.createdAt) || right.finding.id - left.finding.id);
  const patterns: IRecurringPattern[] = [];
  for (const candidate of candidates) {
    if (patterns.some((pattern) => pattern.file === candidate.finding.file && lexicalOverlap(normalizeQuestion(pattern.message), candidate.finding.messageNorm) >= FINDING_OVERLAP_THRESHOLD)) continue;
    patterns.push({ file: candidate.finding.file!, severity: candidate.finding.severity, message: candidate.finding.message, count: candidate.count });
    if (patterns.length >= limit) break;
  }
  return { patterns, findingsConsulted: eligible.length, comparisons };
}

export function persistFindings(db: ContextDatabase, input: { projectId: number; runId: string; findings: ReviewResult['findings']; root?: string }): void {
  for (const finding of input.findings) {
    let file: string | null = finding.file ? posix(finding.file) : null;
    if (file && input.root && path.isAbsolute(finding.file!)) { const relative = path.relative(input.root, finding.file!); file = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? null : posix(relative); }
    db.addFlowFinding({ projectId: input.projectId, runId: input.runId, file, severity: finding.severity, message: finding.message, messageNorm: normalizeQuestion(finding.message) });
  }
}

export function recurringForFiles(db: ContextDatabase, projectId: number, files: string[], limit = 3): IRecurringFindingResult {
  const all: IFlowFinding[] = [];
  for (const file of [...new Set(files.map(posix))]) all.push(...db.listFlowFindings(projectId, file));
  return recurringFindings(all, limit);
}

function changedSymbols(bundle: IDiffBundle): string[] {
  const symbols = new Set<string>();
  const declaration = /\b(?:class|interface|function|def|func|struct|enum|type)\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;
  for (const file of bundle.touchedFiles) {
    let found = false;
    for (const line of (bundle.patches[file] ?? '').split(/\r?\n/)) { if (!/^[+-](?![+-])/.test(line)) continue; const match = line.match(declaration); const name = match?.[1] ?? match?.[2]; if (name) { symbols.add(name); found = true; } }
    if (!found) symbols.add(path.basename(file, path.extname(file)));
  }
  return [...symbols];
}

export function reviewContextSnippets(db: ContextDatabase, projectId: number, bundle: IDiffBundle, limit = 5): ISearchResult[] {
  const results: ISearchResult[] = []; const seen = new Set<number>(); const queries = [...changedSymbols(bundle), ...bundle.touchedFiles.map((file) => path.basename(file, path.extname(file)))];
  for (const query of [...new Set(queries)]) { for (const result of db.searchProject(query, projectId, limit, 'general')) { if (seen.has(result.id)) continue; seen.add(result.id); results.push(result); if (results.length >= limit) return results; } }
  return results;
}

export function formatRecurringPatterns(patterns: IRecurringPattern[]): string {
  if (!patterns.length) return 'knownPatterns: none';
  return `knownPatterns:\n${patterns.map((pattern) => `- ${pattern.file}: ${JSON.stringify(pattern.message)} (seen ${pattern.count}x, ${pattern.severity})`).join('\n')}`;
}

export function formatContextSnippets(results: ISearchResult[]): string {
  if (!results.length) return 'reviewContext: no indexed snippets found';
  return `reviewContext snippets:\n${results.map((result) => `- ${result.path}:${result.startLine} ${result.snippet.replace(/\s+/g, ' ').trim()}`).join('\n')}`;
}
