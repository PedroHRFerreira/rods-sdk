import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { ContextDatabase } from '../database/database.js';
import { classifyTask, loadComplexityPolicy } from '../escalation/index.js';
import { runAgent, type ReviewResult } from '../services/agent-runner.js';
import { loadGovernanceConfig, type AdapterTarget, type IGovernanceConfig } from '../services/adapters.js';
import { loadConfig } from '../services/config.js';
import {
  buildReviewDiff,
  formatContextSnippets,
  formatRecurringPatterns,
  persistFindings,
  recurringFindings,
  recurringForFiles,
  reviewContextSnippets,
  runTestGate,
  type IRecurringFindingResult
} from '../services/flow-review.js';

type FlowMode = 'codex' | 'claude' | 'codex+claude' | 'claude+codex';
function git(root: string, args: string[]): string { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }); }
function agents(mode: FlowMode): [AdapterTarget, AdapterTarget] { const parts = mode.split('+') as AdapterTarget[]; return [parts[0], parts[1] ?? parts[0]]; }
function execution(config: IGovernanceConfig, agent: AdapterTarget) { const value = config.targets[agent].execution; if (!value) throw new Error(`Execution is not configured for ${agent}`); return value; }
function compactTask(task: string): string { return task.trim().replace(/\s+/g, ' ').slice(0, 4000); }
function posix(value: string): string { return value.split(path.sep).join('/').replace(/^\.\//, ''); }

export function buildDeveloperPrompt(task: string, review?: ReviewResult, recurring?: IRecurringFindingResult, correctionDiff?: string): string {
  if (!review) return `Implement this task in the current worktree. Run relevant tests and leave all changes in the worktree. Task: ${compactTask(task)}`;
  return `Correct only the outstanding review findings for this task. Do not restart the implementation. Task: ${compactTask(task)}\nFindings: ${JSON.stringify(review.findings)}\n${formatRecurringPatterns(recurring?.patterns ?? [])}\nCurrent diff:\n${correctionDiff ?? ''}`;
}

export function registerFlowCommand(program: Command): void {
  const flow = program.command('flow').description('Run an isolated CLI-first agent workflow');

  flow.command('findings')
    .requiredOption('--file <path>', 'project-relative file path')
    .option('--project <name>', 'registered project name')
    .option('--root <path>', 'project root', '.')
    .option('--json')
    .action((options: { file: string; project?: string; root: string; json?: boolean }) => {
      const root = path.resolve(options.root); const db = new ContextDatabase(loadConfig());
      try {
        const project = options.project ? db.listProjects().find((item) => item.name === options.project) : db.findProjectForPath(root);
        if (!project) throw new Error(options.project ? `Unknown project: ${options.project}` : `No registered project contains ${root}`);
        const absolute = path.resolve(options.project ? project.root : root, options.file); const relative = path.relative(project.root, absolute);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('--file must resolve inside the project');
        const result = recurringFindings(db.listFlowFindings(project.id, posix(relative)));
        const output = { project: project.name, file: posix(relative), ...result };
        if (options.json) console.log(JSON.stringify(output));
        else { console.log(`project=${project.name} file=${output.file} findingsConsulted=${result.findingsConsulted} comparisons=${result.comparisons}`); for (const pattern of result.patterns) console.log(`severity=${pattern.severity} count=${pattern.count} message=${JSON.stringify(pattern.message)}`); }
      } finally { db.close(); }
    });

  flow.command('run').argument('<task>').option('--mode <mode>').option('--root <path>', 'project root', '.').option('--json').action(async (task: string, options: { mode?: FlowMode; root: string; json?: boolean }) => {
    const root = path.resolve(options.root); const config = await loadGovernanceConfig(root); const mode = options.mode ?? config.workflow?.mode ?? 'codex';
    if (!['codex','claude','codex+claude','claude+codex'].includes(mode)) throw new Error(`Invalid flow mode: ${mode}`);
    if (!config.escalation?.enabled || config.escalation.mode !== 'execute') throw new Error('Enable escalation and set escalation.mode to "execute" before running agents');
    git(root, ['rev-parse','--show-toplevel']);
    const policy = await loadComplexityPolicy(root); let classification = classifyTask({ task, root, policy, preExecution: true });
    const [developer, reviewer] = agents(mode); const maxIterations = config.workflow?.maxIterations ?? 3; const failOnSeverity = config.workflow?.failOnSeverity ?? 'high';
    if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) throw new Error('workflow.maxIterations must be >= 1');
    if (failOnSeverity !== 'high' && failOnSeverity !== 'medium') throw new Error('workflow.failOnSeverity must be high or medium');
    const id = randomUUID(); const short = id.slice(0, 8); const worktree = path.join(os.tmpdir(), `rods-flow-${short}`); const branch = `rods-flow/${short}`; const patchPath = path.join(os.tmpdir(), `rods-flow-${short}.patch`);
    git(root, ['worktree','add','-b',branch,worktree,'HEAD']);
    const db = new ContextDatabase(loadConfig()); const project = db.findProjectForPath(root) ?? db.upsertProject(path.basename(root), root);
    db.createFlowRun({ id, projectId: project.id, task: compactTask(task), mode, tier: classification.level, status: 'running', worktreePath: worktree });
    let status = 'failed', iterations = 0, review: ReviewResult | undefined, error: string | undefined;
    const usage: Array<{ phase: string; agent: AdapterTarget; inputTokens: number | null; outputTokens: number | null; durationMs: number }> = [];
    const omittedFiles = new Set<string>(); let reviewsExecuted = 0, reviewsAvoidedByGate = 0, snippetsUsed = 0, findingsConsulted = 0, findingComparisons = 0;
    let recurring: IRecurringFindingResult | undefined;
    const recordFailure = (phase: string, agent: AdapterTarget, cause: unknown, started: number) => db.addFlowStep({ runId: id, phase, agent, model: execution(config, agent).models[classification.level], status: 'failed', durationMs: Date.now() - started, error: cause instanceof Error ? cause.message : String(cause) });
    try {
      for (iterations = 1; iterations <= maxIterations; iterations++) {
        const phase = iterations === 1 ? 'develop' : 'patch'; const started = Date.now();
        try {
          const priorityFiles = review?.findings.flatMap((finding) => finding.file ? [finding.file] : []) ?? [];
          const correctionDiff = iterations === 1 ? undefined : buildReviewDiff(worktree, { priorityFiles });
          const phaseTier = classification.level;
          const prompt = buildDeveloperPrompt(task, iterations === 1 ? undefined : review, recurring, correctionDiff?.content);
          const result = await runAgent({ agent: developer, config: execution(config, developer), tier: phaseTier, cwd: worktree, prompt });
          usage.push({ phase, agent: developer, inputTokens: result.inputTokens, outputTokens: result.outputTokens, durationMs: result.durationMs });
          db.addFlowStep({ runId: id, phase, agent: developer, model: execution(config, developer).models[phaseTier], status: 'completed', durationMs: result.durationMs, inputTokens: result.inputTokens, outputTokens: result.outputTokens, exitCode: result.exitCode, summary: result.output.slice(0, 2000) });
        } catch (cause) { recordFailure(phase, developer, cause, started); throw cause; }

        if (iterations === 1) classification = classifyTask({ task, root: worktree, policy });

        let bundle = buildReviewDiff(worktree);
        recurring = recurringForFiles(db, project.id, bundle.touchedFiles);
        bundle = buildReviewDiff(worktree, { recurringFiles: recurring.patterns.map((pattern) => pattern.file) });
        for (const file of bundle.omittedFiles) omittedFiles.add(file);
        findingsConsulted += recurring.findingsConsulted; findingComparisons += recurring.comparisons;

        const gate = runTestGate(config.workflow?.testCommand, worktree);
        db.addFlowStep({ runId: id, phase: 'test', agent: 'system', model: 'none', status: gate.status, durationMs: gate.durationMs, exitCode: gate.status === 'passed' ? 0 : gate.status === 'failed' ? 1 : null, summary: gate.output?.slice(-2000) });

        if (gate.status === 'failed') {
          review = { approved: false, summary: 'Automated test gate failed before LLM review.', findings: [gate.finding!] };
          persistFindings(db, { projectId: project.id, runId: id, findings: review.findings, root: worktree }); reviewsAvoidedByGate++;
          db.addFlowStep({ runId: id, phase: 'review', agent: 'system', model: 'none', status: 'changes_requested', durationMs: 0, approved: false, summary: JSON.stringify({ review, modelClaimedApproved: null, testGate: gate.status, diff: { includedFiles: bundle.includedFiles, omittedFiles: bundle.omittedFiles }, recurring, reviewContext: { enabled: false, snippets: 0 } }) });
          continue;
        }

        let contextResults: ReturnType<typeof reviewContextSnippets> = []; let contextError: string | undefined;
        if (config.workflow?.reviewContext) { try { contextResults = reviewContextSnippets(db, project.id, bundle); } catch (cause) { contextError = cause instanceof Error ? cause.message : String(cause); } }
        snippetsUsed += contextResults.length;
        const reviewStarted = Date.now();
        try {
          const prompt = `Review the implementation for correctness, regressions, security, and tests. Return only the required JSON. Task: ${compactTask(task)}\n${gate.status === 'passed' ? 'testCommand: passed' : 'testCommand: not configured'}\n${formatRecurringPatterns(recurring.patterns)}\n${config.workflow?.reviewContext ? formatContextSnippets(contextResults) : 'reviewContext: disabled'}\nTracked and untracked diff bundle:\n${bundle.content}`;
          const result = await runAgent({ agent: reviewer, config: execution(config, reviewer), tier: classification.level, cwd: worktree, review: true, failOnSeverity, prompt });
          review = result.review!; reviewsExecuted++;
          persistFindings(db, { projectId: project.id, runId: id, findings: review.findings, root: worktree });
          db.addFlowStep({ runId: id, phase: 'review', agent: reviewer, model: execution(config, reviewer).models[classification.level], status: review.approved ? 'approved' : 'changes_requested', durationMs: result.durationMs, inputTokens: result.inputTokens, outputTokens: result.outputTokens, exitCode: result.exitCode, modelClaimedApproved: result.modelClaimedApproved, approved: review.approved, summary: JSON.stringify({ review, modelClaimedApproved: result.modelClaimedApproved, testGate: gate.status, diff: { includedFiles: bundle.includedFiles, omittedFiles: bundle.omittedFiles }, recurring, reviewContext: { enabled: config.workflow?.reviewContext ?? false, snippets: contextResults.length, error: contextError } }).slice(0, 12000) });
          usage.push({ phase: 'review', agent: reviewer, inputTokens: result.inputTokens, outputTokens: result.outputTokens, durationMs: result.durationMs });
        } catch (cause) { recordFailure('review', reviewer, cause, reviewStarted); throw cause; }
        if (review.approved) { status = 'approved'; break; }
      }
      if (status !== 'approved') status = 'max_iterations';
      git(worktree, ['add','-A']); const patch = git(worktree, ['diff','--cached','--binary','HEAD']); await fs.writeFile(patchPath, patch);
      db.finishFlowRun(id, { status, tier: classification.level, patchPath, iterations: Math.min(iterations, maxIterations) });
      const knownInputTokens = usage.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0); const knownOutputTokens = usage.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0); const unavailableSteps = usage.filter((item) => item.inputTokens === null || item.outputTokens === null).length;
      const reviewMetrics = { reviewsExecuted, reviewsAvoidedByGate, omittedFiles: [...omittedFiles], snippetsUsed, findingsConsulted, findingComparisons };
      const output = { id, status, tier: classification.level, mode, iterations: Math.min(iterations, maxIterations), worktree, branch, patchPath, review, usage, reviewMetrics, totals: { knownInputTokens, knownOutputTokens, unavailableSteps } };
      if (options.json) console.log(JSON.stringify(output)); else { console.log(`run=${id} status=${status} tier=${classification.level} iterations=${output.iterations}`); for (const item of usage) console.log(`step=${item.phase} agent=${item.agent} inputTokens=${item.inputTokens ?? 'unavailable'} outputTokens=${item.outputTokens ?? 'unavailable'} durationMs=${item.durationMs}`); console.log(`reviewsExecuted=${reviewsExecuted} reviewsAvoidedByGate=${reviewsAvoidedByGate} snippetsUsed=${snippetsUsed} findingsConsulted=${findingsConsulted} findingComparisons=${findingComparisons}`); console.log(`knownInputTokens=${knownInputTokens} knownOutputTokens=${knownOutputTokens} unavailableSteps=${unavailableSteps}`); console.log(`worktree=${worktree}`); console.log(`patch=${patchPath}`); console.log(`apply=git apply ${JSON.stringify(patchPath)}`); if (review && !review.approved) for (const finding of review.findings) console.log(`finding=${finding.severity}:${finding.message}`); }
      if (status !== 'approved') process.exitCode = 2;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause); db.finishFlowRun(id, { status: 'failed', tier: classification.level, iterations: Math.min(iterations, maxIterations), error }); throw cause;
    } finally { db.close(); }
  });
}
