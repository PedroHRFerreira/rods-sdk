import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fg from 'fast-glob';
import { sha256 } from '../utils/hash.js';
import { extractOutput } from './agent-runner.js';
import { initProject, pathExists, type IFileWriteResult } from './scaffold.js';
import { AGENT_TARGET_IDS, loadGovernanceConfig, syncAdapters, type AgentTarget } from './adapters.js';

export interface SkillDraft { name: string; description: string; content: string }
export interface SkillProposal { plan: string; skills: SkillDraft[] }
export interface WizardIO { ask(question: string): Promise<string>; write(message: string): void }
const REQUIRED = ['context-search-first', 'review', 'architecture', 'quality'];
const EXCLUDED = ['**/.git/**', '**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**', '**/.nuxt/**', '**/.venv/**', '**/.env*', '**/.npmrc', '**/.pypirc', '**/.aws/**', '**/.ssh/**', '**/*secret*', '**/*credential*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/.rods/**'];

export async function installedAgents(env = process.env): Promise<AgentTarget[]> {
  const dirs = (env.PATH ?? '').split(path.delimiter);
  const found: AgentTarget[] = [];
  for (const agent of AGENT_TARGET_IDS) {
    for (const dir of dirs) {
      try { await fs.access(path.join(dir, agent), constants.X_OK); found.push(agent); break; } catch { /* next directory */ }
    }
  }
  return found;
}

export async function createPlanningSnapshot(root: string): Promise<{ directory: string; files: string[]; omitted: number; cleanup(): Promise<void> }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rods-skill-plan-'));
  const files: string[] = [];
  let bytes = 0, omitted = 0;
  try {
    let candidates: string[];
    try {
      candidates = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
    } catch {
      candidates = await fg('**/*', { cwd: root, dot: true, onlyFiles: true, followSymbolicLinks: false, ignore: EXCLUDED });
    }
    for (const relative of candidates.sort()) {
      if (relative.split('/').some((part) => ['.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', '.venv', '.rods', '.aws', '.ssh', '.npmrc', '.pypirc'].includes(part) || part.startsWith('.env') || /secret|credential/i.test(part) || /\.(pem|key)$/i.test(part))) continue;
      const source = path.join(root, relative);
      const stat = await fs.lstat(source);
      if (!stat.isFile()) continue;
      if (stat.size > 1_000_000 || bytes + stat.size > 20_000_000) { omitted++; continue; }
      const content = await fs.readFile(source);
      if (content.includes(0) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,})\b|(?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?[A-Za-z0-9_\-]{12,}/i.test(content.toString('utf8'))) { omitted++; continue; }
      const target = path.join(directory, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
      files.push(relative); bytes += stat.size;
    }
    return { directory, files, omitted, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
  } catch (cause) { await fs.rm(directory, { recursive: true, force: true }); throw cause; }
}

export async function runPlanningAgent(input: { agent: AgentTarget; model: string; cwd: string; prompt: string; binary?: string; timeoutMs?: number }): Promise<string> {
  if (!input.model.trim()) throw new Error('Planning model is required');
  const binary = input.binary ?? input.agent;
  const args = input.agent === 'codex'
    ? ['exec', '--model', input.model, '--json', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '-']
    : input.agent === 'claude'
      ? ['--print', '--model', input.model, '--output-format', 'json', '--no-session-persistence', '--permission-mode', 'plan', input.prompt]
      : ['--model', input.model, '--output-format', 'json', '--approval-mode', 'plan', '--prompt', input.prompt];
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: input.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (cause?: Error, code?: number | null) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (cause) return reject(cause);
      const output = extractOutput(input.agent, stdout).output;
      if (code !== 0) return reject(new Error(`Planning CLI exited ${code}: ${stderr.slice(-1000)}`));
      resolve(output);
    };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(new Error('Planning CLI timed out')); }, input.timeoutMs ?? 180_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 1_000_000) { child.kill('SIGTERM'); finish(new Error('Planning CLI output exceeded 1 MB')); } });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.stdin.on('error', (cause: NodeJS.ErrnoException) => { if (cause.code !== 'EPIPE') finish(cause); });
    child.on('error', finish); child.on('close', (code) => finish(undefined, code));
    if (input.agent === 'codex') child.stdin.end(input.prompt); else child.stdin.end();
  });
}

function parseJson(text: string): Record<string, unknown> {
  const clean = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  const value = JSON.parse(clean) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Planning CLI returned invalid JSON');
  return value as Record<string, unknown>;
}

export function validateSkillProposal(value: unknown): SkillProposal {
  if (!value || typeof value !== 'object') throw new Error('Invalid skill proposal');
  const proposal = value as { plan?: unknown; skills?: unknown };
  if (typeof proposal.plan !== 'string' || !proposal.plan.trim() || !Array.isArray(proposal.skills) || proposal.skills.length > 16) throw new Error('Invalid skill proposal');
  const skills: SkillDraft[] = [];
  for (const candidate of proposal.skills) {
    if (!candidate || typeof candidate !== 'object') throw new Error('Invalid skill');
    const skill = candidate as Partial<SkillDraft>;
    if (typeof skill.name !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(skill.name) || typeof skill.description !== 'string' || !skill.description.trim() || typeof skill.content !== 'string' || skill.content.length < 80 || skill.content.length > 16_000 || !skill.content.startsWith('---\n') || !new RegExp(`^name: ${skill.name}$`, 'm').test(skill.content) || !skill.content.includes('\n---\n') || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,})\b/.test(skill.content)) throw new Error(`Invalid skill: ${String(skill.name)}`);
    if (skills.some((existing) => existing.name === skill.name)) throw new Error(`Duplicate skill: ${skill.name}`);
    skills.push(skill as SkillDraft);
  }
  if (REQUIRED.some((name) => !skills.some((skill) => skill.name === name))) throw new Error(`The proposal must include ${REQUIRED.join(', ')}`);
  return { plan: proposal.plan, skills };
}

export async function applySkillProposal(root: string, proposal: SkillProposal, force = false): Promise<IFileWriteResult[]> {
  const configPath = path.join(root, '.ai', 'config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as { generatedTemplates?: Record<string, string>; aiGeneratedSkills?: Record<string, string>; selectedSkills?: string[] };
  const metadata = { ...(config.generatedTemplates ?? {}) };
  const generated = { ...(config.aiGeneratedSkills ?? {}) };
  const results: IFileWriteResult[] = [];
  const selected = new Set(proposal.skills.map((skill) => skill.name));
  for (const [relative, hash] of Object.entries(generated)) {
    const match = relative.match(/^\.ai\/skills\/([a-z0-9-]+)\/SKILL\.md$/);
    if (!match || selected.has(match[1])) continue;
    const target = path.join(root, relative);
    if (await pathExists(target) && sha256(await fs.readFile(target)) === hash) {
      await fs.unlink(target);
      delete generated[relative]; delete metadata[relative];
      results.push({ path: target, status: 'removed' });
    }
  }
  for (const skill of proposal.skills) {
    const relative = `.ai/skills/${skill.name}/SKILL.md`;
    const target = path.join(root, relative);
    const exists = await pathExists(target);
    const current = exists ? sha256(await fs.readFile(target)) : null;
    if (exists && !force && current !== metadata[relative] && current !== generated[relative]) { results.push({ path: target, status: 'customized' }); continue; }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, skill.content.endsWith('\n') ? skill.content : `${skill.content}\n`);
    const hash = sha256(await fs.readFile(target));
    metadata[relative] = hash; generated[relative] = hash;
    results.push({ path: target, status: exists ? 'overwritten' : 'created' });
  }
  const agentsPath = path.join(root, 'AGENTS.md');
  if (await pathExists(agentsPath)) {
    const current = await fs.readFile(agentsPath, 'utf8');
    if (force || sha256(current) === metadata['AGENTS.md']) {
      const names = new Set(proposal.skills.map((skill) => skill.name));
      const updated = current.split('\n').filter((line) => {
        const match = line.match(/\.ai\/skills\/([a-z0-9-]+)\/SKILL\.md/);
        return !match || names.has(match[1]);
      }).join('\n');
      if (updated !== current) {
        await fs.writeFile(agentsPath, updated);
        metadata['AGENTS.md'] = sha256(updated);
        results.push({ path: agentsPath, status: 'overwritten' });
      }
    }
  }
  config.generatedTemplates = metadata;
  config.aiGeneratedSkills = generated;
  config.selectedSkills = proposal.skills.map((skill) => skill.name);
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return results;
}

export async function runInitWizard(root: string, io: WizardIO, options: { force?: boolean; env?: NodeJS.ProcessEnv; availableAgents?: AgentTarget[]; planningAgent?: typeof runPlanningAgent } = {}): Promise<{ status: 'applied' | 'cancelled' | 'unavailable'; files: IFileWriteResult[] }> {
  const available = options.availableAgents ?? await installedAgents(options.env);
  const planner = options.planningAgent ?? runPlanningAgent;
  if (!available.length) return { status: 'unavailable', files: [] };
  io.write(`CLIs disponíveis: ${available.join(', ')}`);
  const config = await loadGovernanceConfig(root);
  const suggested = available.includes(config.defaultTarget) ? config.defaultTarget : available[0];
  const selected = (await io.ask(`Agente para planejar skills [${suggested}]: `)).trim() || suggested;
  if (!available.includes(selected as AgentTarget)) throw new Error(`Agent CLI not available: ${selected}`);
  const execution = config.targets[selected as AgentTarget].execution;
  const defaultModel = execution?.models.medium || execution?.models.high || '';
  const model = (await io.ask(`Modelo para esta geração${defaultModel ? ` [${defaultModel}]` : ''}: `)).trim() || defaultModel;
  if (!model) return { status: 'cancelled', files: [] };
  const snapshot = await createPlanningSnapshot(root);
  try {
    io.write(`Arquivos analisáveis: ${snapshot.files.length}. Arquivos omitidos por tamanho, formato ou conteúdo sensível: ${snapshot.omitted}. Arquivos ignorados e credenciais também foram excluídos.`);
    const history: Array<{ question: string; answer: string }> = [];
    let plan = '';
    for (let turn = 0; turn < 6; turn++) {
      const prompt = `Você está planejando skills RODS para um projeto. Examine os arquivos desta cópia de leitura. Faça apenas perguntas que mudem as skills. Responda SOMENTE JSON com {"findings":"resumo breve","question":"uma pergunta ou null","plan":"plano completo ou null"}. Gere o plano quando houver informações suficientes ou após 3 respostas. Skills essenciais: ${REQUIRED.join(', ')}. Histórico: ${JSON.stringify(history)}.`;
      const result = parseJson(await planner({ agent: selected as AgentTarget, model, binary: execution?.binary, cwd: snapshot.directory, prompt }));
      if (typeof result.findings === 'string') io.write(result.findings);
      if (typeof result.plan === 'string' && result.plan.trim()) { plan = result.plan; break; }
      if (typeof result.question !== 'string' || !result.question.trim()) throw new Error('Planning CLI did not provide a question or plan');
      const answer = await io.ask(`${result.question}\n> `);
      history.push({ question: result.question, answer });
    }
    if (!plan) throw new Error('Planning CLI did not complete a plan');
    for (let revision = 0; revision < 3; revision++) {
      io.write(`\nPlano proposto:\n${plan}`);
      const answer = (await io.ask('Aceitar plano, revisar ou cancelar? [a/r/c]: ')).trim().toLowerCase();
      if (answer === 'c') return { status: 'cancelled', files: [] };
      if (answer === 'a') break;
      if (answer !== 'r') { revision--; continue; }
      const change = await io.ask('O que deve mudar? ');
      const result = parseJson(await planner({ agent: selected as AgentTarget, model, binary: execution?.binary, cwd: snapshot.directory, prompt: `Revise este plano de skills conforme o usuário. Responda SOMENTE JSON {"plan":"plano revisado"}. Plano: ${plan}\nPedido: ${change}` }));
      if (typeof result.plan !== 'string' || !result.plan.trim()) throw new Error('Invalid revised plan');
      plan = result.plan;
      if (revision === 2) return { status: 'cancelled', files: [] };
    }
    const prompt = `Examine este projeto e gere skills RODS conforme o plano aprovado. Responda SOMENTE JSON {"plan":"...","skills":[{"name":"...","description":"...","content":"---\\nname: ...\\ndescription: ...\\n---\\n\\n..."}]}. Inclua exatamente as essenciais ${REQUIRED.join(', ')} e somente skills adicionais relevantes. Cada skill deve ter instruções concretas, comandos reais e referências que existam. Não inclua segredos. Plano: ${plan}`;
    const result = parseJson(await planner({ agent: selected as AgentTarget, model, binary: execution?.binary, cwd: snapshot.directory, prompt }));
    const proposal = validateSkillProposal({ ...result, plan });
    io.write(`\nPrévia de ${proposal.skills.length} skills:`);
    for (const skill of proposal.skills) {
      const target = path.join(root, '.ai', 'skills', skill.name, 'SKILL.md');
      const previous = await pathExists(target) ? await fs.readFile(target, 'utf8') : '';
      io.write(`\n--- ${target}${previous ? '' : ' (novo)'}\n${previous ? previous.split('\n').map((line) => `-${line}`).join('\n') : ''}\n+++ proposta\n${skill.content.split('\n').map((line) => `+${line}`).join('\n')}`);
    }
    const answer = (await io.ask('Aplicar esta proposta e inicializar o RODS? [s/N]: ')).trim().toLowerCase();
    if (answer !== 's' && answer !== 'sim') return { status: 'cancelled', files: [] };
    const files = await initProject(root, { force: options.force, skillNames: proposal.skills.map((skill) => skill.name) });
    files.push(...await applySkillProposal(root, proposal, options.force));
    await syncAdapters(root, 'codex', { force: options.force });
    return { status: 'applied', files };
  } finally { await snapshot.cleanup(); }
}
