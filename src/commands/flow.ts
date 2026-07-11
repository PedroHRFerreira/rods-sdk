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

type FlowMode = 'codex' | 'claude' | 'codex+claude' | 'claude+codex';
function git(root: string, args: string[]): string { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }); }
function agents(mode: FlowMode): [AdapterTarget, AdapterTarget] { const parts = mode.split('+') as AdapterTarget[]; return [parts[0], parts[1] ?? parts[0]]; }
function execution(config: IGovernanceConfig, agent: AdapterTarget) { const value = config.targets[agent].execution; if (!value) throw new Error(`Execution is not configured for ${agent}`); return value; }
function compactTask(task: string): string { return task.trim().replace(/\s+/g, ' ').slice(0, 4000); }

export function registerFlowCommand(program: Command): void {
  const flow = program.command('flow').description('Run an isolated CLI-first agent workflow');
  flow.command('run').argument('<task>').option('--mode <mode>').option('--root <path>', 'project root', '.').option('--json').action(async (task: string, options: { mode?: FlowMode; root: string; json?: boolean }) => {
    const root = path.resolve(options.root); const config = await loadGovernanceConfig(root); const mode = options.mode ?? config.workflow?.mode ?? 'codex';
    if (!['codex','claude','codex+claude','claude+codex'].includes(mode)) throw new Error(`Invalid flow mode: ${mode}`);
    if (!config.escalation?.enabled || config.escalation.mode !== 'execute') throw new Error('Enable escalation and set escalation.mode to "execute" before running agents');
    git(root, ['rev-parse','--show-toplevel']);
    const policy = await loadComplexityPolicy(root); const classification = classifyTask({ task, root, policy });
    const [developer, reviewer] = agents(mode); const maxIterations = config.workflow?.maxIterations ?? 3;
    if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) throw new Error('workflow.maxIterations must be >= 1');
    const id = randomUUID(); const short = id.slice(0, 8); const worktree = path.join(os.tmpdir(), `rods-flow-${short}`); const branch = `rods-flow/${short}`; const patchPath = path.join(os.tmpdir(), `rods-flow-${short}.patch`);
    git(root, ['worktree','add','-b',branch,worktree,'HEAD']);
    const db = new ContextDatabase(loadConfig()); const project = db.findProjectForPath(root) ?? db.upsertProject(path.basename(root), root);
    db.createFlowRun({ id, projectId: project.id, task: compactTask(task), mode, tier: classification.level, status: 'running', worktreePath: worktree });
    let status = 'failed', iterations = 0, review: ReviewResult | undefined, error: string | undefined;
    const usage: Array<{ phase: string; agent: AdapterTarget; inputTokens: number | null; outputTokens: number | null; durationMs: number }> = [];
    const recordFailure = (phase: string, agent: AdapterTarget, cause: unknown, started: number) => db.addFlowStep({ runId: id, phase, agent, model: execution(config, agent).models[classification.level], status: 'failed', durationMs: Date.now() - started, error: cause instanceof Error ? cause.message : String(cause) });
    try {
      for (iterations = 1; iterations <= maxIterations; iterations++) {
        const phase = iterations === 1 ? 'develop' : 'patch'; const started = Date.now();
        try {
          const prompt = iterations === 1
            ? `Implement this task in the current worktree. Run relevant tests and leave all changes in the worktree. Task: ${compactTask(task)}`
            : `Correct only the outstanding review findings for this task. Do not restart the implementation. Task: ${compactTask(task)}\nFindings: ${JSON.stringify(review?.findings ?? [])}\nCurrent diff:\n${git(worktree, ['diff','--no-ext-diff','HEAD']).slice(0, 50000)}`;
          const result = await runAgent({ agent: developer, config: execution(config, developer), tier: classification.level, cwd: worktree, prompt });
          usage.push({ phase, agent: developer, inputTokens: result.inputTokens, outputTokens: result.outputTokens, durationMs: result.durationMs });
          db.addFlowStep({ runId: id, phase, agent: developer, model: execution(config, developer).models[classification.level], status: 'completed', durationMs: result.durationMs, inputTokens: result.inputTokens, outputTokens: result.outputTokens, exitCode: result.exitCode, summary: result.output.slice(0, 2000) });
        } catch (cause) { recordFailure(phase, developer, cause, started); throw cause; }
        const diff = git(worktree, ['diff','--no-ext-diff','HEAD']); const untracked = git(worktree, ['ls-files','--others','--exclude-standard']);
        const reviewStarted = Date.now();
        try {
          const result = await runAgent({ agent: reviewer, config: execution(config, reviewer), tier: classification.level, cwd: worktree, review: true, prompt: `Review the implementation for correctness, regressions, security, and tests. Return only the required JSON. Task: ${compactTask(task)}\nTracked diff:\n${diff.slice(0, 50000)}\nUntracked files:\n${untracked.slice(0, 10000)}` });
          review = result.review!; db.addFlowStep({ runId: id, phase: 'review', agent: reviewer, model: execution(config, reviewer).models[classification.level], status: review.approved ? 'approved' : 'changes_requested', durationMs: result.durationMs, inputTokens: result.inputTokens, outputTokens: result.outputTokens, exitCode: result.exitCode, summary: JSON.stringify(review).slice(0, 4000) });
          usage.push({ phase: 'review', agent: reviewer, inputTokens: result.inputTokens, outputTokens: result.outputTokens, durationMs: result.durationMs });
        } catch (cause) { recordFailure('review', reviewer, cause, reviewStarted); throw cause; }
        if (review.approved) { status = 'approved'; break; }
      }
      if (status !== 'approved') status = 'max_iterations';
      git(worktree, ['add','-A']); const patch = git(worktree, ['diff','--cached','--binary','HEAD']); await fs.writeFile(patchPath, patch);
      db.finishFlowRun(id, { status, patchPath, iterations: Math.min(iterations, maxIterations) });
      const knownInputTokens = usage.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0); const knownOutputTokens = usage.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0); const unavailableSteps = usage.filter((item) => item.inputTokens === null || item.outputTokens === null).length;
      const output = { id, status, tier: classification.level, mode, iterations: Math.min(iterations, maxIterations), worktree, branch, patchPath, review, usage, totals: { knownInputTokens, knownOutputTokens, unavailableSteps } };
      if (options.json) console.log(JSON.stringify(output)); else { console.log(`run=${id} status=${status} tier=${classification.level} iterations=${output.iterations}`); for (const item of usage) console.log(`step=${item.phase} agent=${item.agent} inputTokens=${item.inputTokens ?? 'unavailable'} outputTokens=${item.outputTokens ?? 'unavailable'} durationMs=${item.durationMs}`); console.log(`knownInputTokens=${knownInputTokens} knownOutputTokens=${knownOutputTokens} unavailableSteps=${unavailableSteps}`); console.log(`worktree=${worktree}`); console.log(`patch=${patchPath}`); console.log(`apply=git apply ${JSON.stringify(patchPath)}`); if (review && !review.approved) for (const finding of review.findings) console.log(`finding=${finding.severity}:${finding.message}`); }
      if (status !== 'approved') process.exitCode = 2;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause); db.finishFlowRun(id, { status: 'failed', iterations: Math.min(iterations, maxIterations), error }); throw cause;
    } finally { db.close(); }
  });
}
