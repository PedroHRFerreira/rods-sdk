import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { ComplexityLevel } from '../escalation/types.js';
import type { AdapterTarget, IAgentExecutionConfig } from './adapters.js';

export const ReviewSchema = z.object({ approved: z.boolean(), summary: z.string(), findings: z.array(z.object({ severity: z.enum(['low','medium','high']), message: z.string(), file: z.string().optional() })) });
export type ReviewResult = z.infer<typeof ReviewSchema>;
export interface IAgentResult { output: string; exitCode: number; durationMs: number; inputTokens: number | null; outputTokens: number | null; review?: ReviewResult; }

const REVIEW_JSON_SCHEMA = { type: 'object', additionalProperties: false, properties: { approved: { type: 'boolean' }, summary: { type: 'string' }, findings: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { severity: { enum: ['low','medium','high'] }, message: { type: 'string' }, file: { type: 'string' } }, required: ['severity','message'] } } }, required: ['approved','summary','findings'] };
const BANNED_ARGS = new Set(['--model','-m','--dangerously-bypass-approvals-and-sandbox','--dangerously-skip-permissions']);

function validate(config: IAgentExecutionConfig, tier: ComplexityLevel): string {
  if (!config.binary.trim()) throw new Error('Agent binary is not configured');
  const model = config.models[tier]?.trim();
  if (!model) throw new Error(`No model configured for tier ${tier}`);
  if (config.args.some((arg) => BANNED_ARGS.has(arg) || arg.startsWith('--model=') || /^-m\S/.test(arg) || arg.startsWith('--dangerously-'))) throw new Error('Agent args contain a reserved or unsafe option');
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1000) throw new Error('Agent timeoutMs must be an integer >= 1000');
  return model;
}

function usageFrom(value: unknown): { input: number | null; output: number | null } {
  let input = 0, output = 0, found = false;
  const visit = (node: unknown) => { if (!node || typeof node !== 'object') return; const record = node as Record<string, unknown>; for (const [key, val] of Object.entries(record)) { if (typeof val === 'number' && /input.*tokens|prompt.*tokens/i.test(key)) { input += val; found = true; } else if (typeof val === 'number' && /output.*tokens|completion.*tokens/i.test(key)) { output += val; found = true; } else if (typeof val === 'object') visit(val); } };
  visit(value); return { input: found ? input : null, output: found ? output : null };
}

function extractOutput(agent: AdapterTarget, stdout: string): { output: string; usage: { input: number | null; output: number | null } } {
  const values = stdout.split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line) as unknown; } catch { return null; } }).filter((value) => value !== null);
  const usage = usageFrom(values);
  if (agent === 'claude') { const envelope = values.at(-1) as Record<string, unknown> | undefined; return { output: typeof envelope?.result === 'string' ? envelope.result : stdout.trim(), usage }; }
  const messages: string[] = [];
  const visit = (node: unknown) => { if (!node || typeof node !== 'object') return; const record = node as Record<string, unknown>; if (record.type === 'agent_message' && typeof record.text === 'string') messages.push(record.text); for (const val of Object.values(record)) if (typeof val === 'object') visit(val); };
  for (const value of values) visit(value);
  return { output: messages.at(-1) ?? stdout.trim(), usage };
}

export async function runAgent(input: { agent: AdapterTarget; config: IAgentExecutionConfig; tier: ComplexityLevel; cwd: string; prompt: string; review?: boolean }): Promise<IAgentResult> {
  const model = validate(input.config, input.tier); const started = Date.now();
  const schemaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rods-schema-')); const schemaPath = path.join(schemaDir, 'review.json');
  if (input.review) await fs.writeFile(schemaPath, JSON.stringify(REVIEW_JSON_SCHEMA));
  const args = input.agent === 'codex'
    ? ['exec','--model',model,'--json','--ephemeral','--sandbox', input.review ? 'read-only' : 'workspace-write', ...(input.review ? ['--output-schema',schemaPath] : []), ...input.config.args, '-']
    : ['--print','--model',model,'--output-format','json','--no-session-persistence','--permission-mode', input.review ? 'plan' : 'acceptEdits', ...(input.review ? ['--json-schema',JSON.stringify(REVIEW_JSON_SCHEMA)] : []), ...input.config.args, input.prompt];
  return await new Promise((resolve, reject) => {
    const child = spawn(input.config.binary, args, { cwd: input.cwd, stdio: ['pipe','pipe','pipe'] }); let stdout = '', stderr = '', settled = false;
    const finish = (error?: Error, code = -1) => { if (settled) return; settled = true; clearTimeout(timer); void fs.rm(schemaDir, { recursive: true, force: true }); if (error) { reject(error); return; } const parsed = extractOutput(input.agent, stdout); if (code !== 0) { reject(new Error(`${input.agent} exited ${code}: ${(stderr.trim() || parsed.output).slice(0, 4000)}`)); return; } try { const review = input.review ? ReviewSchema.parse(JSON.parse(parsed.output)) : undefined; resolve({ output: parsed.output, exitCode: code, durationMs: Date.now() - started, inputTokens: parsed.usage.input, outputTokens: parsed.usage.output, review }); } catch (cause) { reject(new Error(`Invalid structured review from ${input.agent}: ${cause instanceof Error ? cause.message : String(cause)}; output=${JSON.stringify(parsed.output.slice(0, 4000))}`)); } };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(new Error(`${input.agent} timed out after ${input.config.timeoutMs}ms`)); }, input.config.timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; }); child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') finish(error); }); child.on('error', (error) => finish(error)); child.on('close', (code) => finish(undefined, code ?? -1));
    if (input.agent === 'codex') child.stdin.end(input.prompt); else child.stdin.end();
  });
}
