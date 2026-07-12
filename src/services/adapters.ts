import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileIfAllowed, pathExists, writeTemplateFile, type IFileWriteResult } from './scaffold.js';

export const ADAPTER_NAMES = ['rtk', 'claude-mem', 'caveman'] as const;
export const ADAPTER_TARGET_IDS = ['codex', 'claude'] as const;
export const AGENT_TARGET_IDS = ['codex', 'claude', 'gemini'] as const;

export type AdapterName = (typeof ADAPTER_NAMES)[number];
export type AdapterTarget = (typeof ADAPTER_TARGET_IDS)[number];
export type AgentTarget = (typeof AGENT_TARGET_IDS)[number];

export interface IAgentExecutionConfig {
  binary: string;
  models: Record<'simple' | 'medium' | 'high', string>;
  args: string[];
  timeoutMs: number;
}

export interface IWorkflowTestCommand {
  command: string;
  args?: string[];
  timeoutMs?: number;
}

export interface IAdapterState {
  enabled: boolean;
  mode?: string;
}

export interface IGovernanceConfig {
  version: number;
  project: string;
  source: string;
  execution: {
    mode: 'cli';
    apiEnabled: false;
  };
  defaultTarget: AdapterTarget;
  targets: Record<AgentTarget, { enabled: boolean; skillsDir?: string; hooks?: boolean; execution?: IAgentExecutionConfig }>;
  adapters: Record<AdapterName, IAdapterState>;
  escalation?: {
    enabled: boolean;
    policyPath: string;
    specsDir: string;
    mode: 'advisory' | 'execute';
  };
  workflow?: {
    mode: string;
    maxIterations: number;
    failOnSeverity: 'high' | 'medium';
    testCommand?: IWorkflowTestCommand;
    reviewContext: boolean;
  };
  generatedTemplates?: Record<string, string>;
  generatedScripts?: Record<string, string>;
}

export interface IAdapterDefinition {
  name: AdapterName;
  phase: 'token' | 'session-memory' | 'agent-output';
  description: string;
  codexSetup: string;
  binary?: string;
  versionArgs?: string[];
  healthArgs?: string[];
  configTerms: string[];
  hookTerms: string[];
  mcpTerms: string[];
}

export interface IAdapterEnableResult {
  adapter: AdapterName;
  configPath: string;
  files: IFileWriteResult[];
}

export interface IAdapterSyncResult {
  target: AdapterTarget;
  status: 'synced' | 'skipped';
  files: IFileWriteResult[];
  path?: string;
  fallback?: boolean;
  reason?: string;
}

export interface IAdapterSyncOptions {
  force?: boolean;
  codexSkillsDir?: string;
  codexHome?: string;
}

export interface ICommandCheck {
  command: string;
  ok: boolean;
  output?: string;
  error?: string;
}

export interface IAdapterDoctorReport {
  name: AdapterName;
  enabled: boolean;
  installed: boolean;
  version?: string;
  configDetected: boolean;
  hooksDetected: boolean;
  mcpDetected: boolean;
  conflict: string;
  lifecycleHooksDetected?: boolean;
  capabilitiesDetected?: boolean;
  checks: ICommandCheck[];
}

export interface IAdapterDoctorOptions {
  target?: AdapterTarget;
  env?: NodeJS.ProcessEnv;
  codexHome?: string;
  timeoutMs?: number;
}

const ADAPTERS: Record<AdapterName, IAdapterDefinition> = {
  rtk: {
    name: 'rtk',
    phase: 'token',
    description: 'Default adapter: compact shell command output through RTK while Context Engine handles retrieval.',
    codexSetup: 'rtk init -g --codex',
    binary: 'rtk',
    versionArgs: ['--version'],
    healthArgs: ['gain'],
    configTerms: ['rtk', 'RTK.md'],
    hookTerms: ['rtk'],
    mcpTerms: []
  },
  'claude-mem': {
    name: 'claude-mem',
    phase: 'session-memory',
    description: 'Use compressed cross-session memory when prior decisions matter.',
    codexSetup: 'npx claude-mem install',
    binary: 'claude-mem',
    versionArgs: ['--version'],
    configTerms: ['claude-mem'],
    hookTerms: ['claude-mem'],
    mcpTerms: ['claude-mem', 'mem-search']
  },
  caveman: {
    name: 'caveman',
    phase: 'agent-output',
    description: 'Opt-in terse agent output; never compress code, logs, commands, errors, or diffs.',
    codexSetup: 'npx skills add JuliusBrussee/caveman -a codex',
    binary: 'caveman-shrink',
    versionArgs: ['--version'],
    configTerms: ['caveman'],
    hookTerms: ['caveman'],
    mcpTerms: ['caveman-shrink']
  }
};

export interface ITargetIntegrationState {
  configText: string;
  hooksText: string;
  projectText: string;
  externalText: string;
  allText: string;
}

export interface IAdapterTargetDefinition {
  id: AdapterTarget;
  hookPath(root: string, options: IAdapterSyncOptions | IAdapterDoctorOptions): string;
  projectionFn(): Promise<string>;
  syncFn(root: string, options: IAdapterSyncOptions): Promise<IAdapterSyncResult>;
  doctorFn(root: string, options: IAdapterDoctorOptions): Promise<ITargetIntegrationState>;
}

const TARGET_REGISTRY: Record<AdapterTarget, IAdapterTargetDefinition> = {
  codex: {
    id: 'codex',
    hookPath: (_root, options) => path.join(options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'RTK.md'),
    projectionFn: () => renderHookTemplate('codex.md'),
    syncFn: syncCodexTarget,
    doctorFn: readCodexIntegrationState
  },
  claude: {
    id: 'claude',
    hookPath: (root) => path.join(root, 'CLAUDE.md'),
    projectionFn: () => renderHookTemplate('claude.md'),
    syncFn: syncClaudeTarget,
    doctorFn: readClaudeIntegrationState
  }
};

export function listAdapters(): IAdapterDefinition[] {
  return ADAPTER_NAMES.map((name) => ADAPTERS[name]);
}

export function listAdapterTargets(): IAdapterTargetDefinition[] {
  return ADAPTER_TARGET_IDS.map((id) => TARGET_REGISTRY[id]);
}

export function isAdapterTarget(input: string): input is AdapterTarget {
  return (ADAPTER_TARGET_IDS as readonly string[]).includes(input);
}

export function isAgentTarget(input: string): input is AgentTarget {
  return (AGENT_TARGET_IDS as readonly string[]).includes(input);
}

export function isAdapterName(input: string): input is AdapterName {
  return (ADAPTER_NAMES as readonly string[]).includes(input);
}

export async function enableAdapter(
  root: string,
  adapterName: AdapterName,
  options: { force?: boolean } = {}
): Promise<IAdapterEnableResult> {
  const resolvedRoot = path.resolve(root);
  const config = await loadGovernanceConfig(resolvedRoot);
  config.adapters[adapterName] = {
    ...config.adapters[adapterName],
    enabled: true
  };

  if (adapterName === 'caveman') {
    config.adapters.caveman.mode = config.adapters.caveman.mode ?? 'opt-in';
  }

  const configPath = await saveGovernanceConfig(resolvedRoot, config);
  const adapterFile = await writeTemplateFile(
    `ai/adapters/${adapterName}.md.tpl`,
    path.join(resolvedRoot, '.ai', 'adapters', `${adapterName}.md`),
    { projectName: config.project },
    options
  );

  return { adapter: adapterName, configPath, files: [adapterFile] };
}

export async function syncAdapters(
  root: string,
  target: AdapterTarget,
  options: IAdapterSyncOptions = {}
): Promise<IAdapterSyncResult> {
  const resolvedRoot = path.resolve(root);
  const definition = TARGET_REGISTRY[target];

  if (!definition) {
    throw new Error(`Unsupported adapter target: ${target}`);
  }

  return definition.syncFn(resolvedRoot, options);
}

async function syncCodexTarget(root: string, options: IAdapterSyncOptions): Promise<IAdapterSyncResult> {
  const config = await loadGovernanceConfig(root);
  const sourceSkillsDir = path.join(root, '.ai', 'skills');
  const configuredSkillsDir = options.codexSkillsDir ?? config.targets.codex?.skillsDir;

  if (!(await pathExists(sourceSkillsDir))) {
    await writeLifecycleHooks(root, 'codex');
    return {
      target: 'codex',
      status: 'synced',
      path: relativeFromRoot(root, sourceSkillsDir),
      files: [await writeTargetHook(root, TARGET_REGISTRY.codex, options)]
    };
  }

  if (!configuredSkillsDir) {
    await writeLifecycleHooks(root, 'codex');
    return {
      target: 'codex',
      status: 'synced',
      path: relativeFromRoot(root, sourceSkillsDir),
      fallback: false,
      files: [await writeTargetHook(root, TARGET_REGISTRY.codex, options)]
    };
  }

  const destinationSkillsDir = path.resolve(root, configuredSkillsDir);
  const primaryResult = await trySyncCodexTarget(root, sourceSkillsDir, destinationSkillsDir, options);

  if (primaryResult.ok) {
    return {
      target: 'codex',
      status: 'synced',
      path: relativeFromRoot(root, destinationSkillsDir),
      fallback: false,
      files: primaryResult.files
    };
  }

  return {
    target: 'codex',
    status: 'skipped',
    path: relativeFromRoot(root, destinationSkillsDir),
    fallback: false,
    reason: primaryResult.reason,
    files: []
  };
}

async function trySyncCodexTarget(
  root: string,
  sourceSkillsDir: string,
  destinationSkillsDir: string,
  options: IAdapterSyncOptions
): Promise<{ ok: true; files: IFileWriteResult[] } | { ok: false; reason: string }> {
  const files: IFileWriteResult[] = [];

  const entries = await fs.readdir(sourceSkillsDir, { withFileTypes: true });

  try {
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const sourceSkill = path.join(sourceSkillsDir, entry.name, 'SKILL.md');

      if (!(await pathExists(sourceSkill))) {
        continue;
      }

      files.push(
        await copyFileIfAllowed(sourceSkill, path.join(destinationSkillsDir, entry.name, 'SKILL.md'), {
          force: options.force
        })
      );
    }

    files.push(await writeTargetHook(root, TARGET_REGISTRY.codex, options));
    await writeLifecycleHooks(root, 'codex');
  } catch (error) {
    return { ok: false, reason: formatSyncError(error) };
  }

  return { ok: true, files };
}

async function syncClaudeTarget(root: string, options: IAdapterSyncOptions): Promise<IAdapterSyncResult> {
  const files: IFileWriteResult[] = [];

  files.push(await writeTargetHook(root, TARGET_REGISTRY.claude, options));
  await writeLifecycleHooks(root, 'claude');

  return { target: 'claude', status: 'synced', files };
}

export async function doctorAdapters(
  root: string,
  options: IAdapterDoctorOptions = {}
): Promise<IAdapterDoctorReport[]> {
  const target = options.target ?? 'codex';
  const definition = TARGET_REGISTRY[target];

  if (!definition) {
    throw new Error(`Unsupported adapter target: ${target}`);
  }

  const resolvedRoot = path.resolve(root);
  const config = await loadGovernanceConfig(resolvedRoot);
  const integrationState = await definition.doctorFn(resolvedRoot, options);
  const reports: IAdapterDoctorReport[] = [];

  for (const adapter of listAdapters()) {
    const checks = await runAdapterChecks(adapter, {
      env: options.env,
      timeoutMs: options.timeoutMs
    });
    const versionCheck = checks.find((check) => check.command === formatCommand(adapter.binary, adapter.versionArgs));
    const installed = checks.some((check) => check.ok) || detectTerms(integrationState.externalText, adapter.configTerms);
    const enabled = config.adapters[adapter.name]?.enabled ?? false;
    const configDetected = enabled || detectTerms(integrationState.allText, adapter.configTerms);
    const hooksDetected = detectTerms(integrationState.hooksText, adapter.hookTerms);
    const mcpDetected = detectTerms(integrationState.configText, adapter.mcpTerms);

    reports.push({
      name: adapter.name,
      enabled,
      installed,
      version: versionCheck?.ok ? versionCheck.output : undefined,
      configDetected,
      hooksDetected,
      mcpDetected,
      conflict: detectConflict(adapter, integrationState),
      lifecycleHooksDetected: detectTerms(integrationState.hooksText, ['rods hook run']),
      capabilitiesDetected: detectTerms(integrationState.projectText, [`harness: ${target}`]),
      checks
    });
  }

  return reports;
}

export async function loadGovernanceConfig(root: string): Promise<IGovernanceConfig> {
  const resolvedRoot = path.resolve(root);
  const configPath = path.join(resolvedRoot, '.ai', 'config.json');

  if (!(await pathExists(configPath))) {
    return createDefaultConfig(resolvedRoot);
  }

  const parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as Partial<IGovernanceConfig>;
  const defaults = createDefaultConfig(resolvedRoot);

  return {
    ...defaults,
    ...parsed,
    version: Math.max(parsed.version ?? 1, 3),
    escalation: {
      enabled: parsed.escalation?.enabled ?? defaults.escalation?.enabled ?? true,
      policyPath: parsed.escalation?.policyPath ?? defaults.escalation?.policyPath ?? '.ai/policies/complexity.md',
      specsDir: parsed.escalation?.specsDir ?? defaults.escalation?.specsDir ?? 'docs/rods/specs',
      mode: parsed.escalation?.mode ?? ((parsed.escalation as { modelAdviceOnly?: boolean } | undefined)?.modelAdviceOnly === false ? 'execute' : 'advisory')
    },
    targets: mergeAgentTargets(defaults.targets, parsed.targets),
    adapters: {
      ...defaults.adapters,
      ...(parsed.adapters ?? {})
    },
    workflow: { ...defaults.workflow!, ...(parsed.workflow ?? {}) }
  };
}

function mergeAgentTargets(
  defaults: IGovernanceConfig['targets'],
  parsed: Partial<IGovernanceConfig>['targets']
): IGovernanceConfig['targets'] {
  return Object.fromEntries(AGENT_TARGET_IDS.map((target) => {
    const configured = parsed?.[target];
    const defaultExecution = defaults[target].execution!;
    return [target, {
      ...defaults[target],
      ...(configured ?? {}),
      execution: {
        ...defaultExecution,
        ...(configured?.execution ?? {}),
        models: { ...defaultExecution.models, ...(configured?.execution?.models ?? {}) }
      }
    }];
  })) as IGovernanceConfig['targets'];
}

async function saveGovernanceConfig(root: string, config: IGovernanceConfig): Promise<string> {
  const configPath = path.join(root, '.ai', 'config.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

function createDefaultConfig(root: string): IGovernanceConfig {
  return {
    version: 3,
    project: path.basename(root),
    source: '.ai',
    execution: {
      mode: 'cli',
      apiEnabled: false
    },
    defaultTarget: 'codex',
    targets: {
      codex: { enabled: true, hooks: true, execution: { binary: 'codex', models: { simple: '', medium: '', high: '' }, args: [], timeoutMs: 900000 } },
      claude: { enabled: false, hooks: true, execution: { binary: 'claude', models: { simple: '', medium: '', high: '' }, args: [], timeoutMs: 900000 } },
      gemini: { enabled: false, execution: { binary: 'gemini', models: { simple: '', medium: '', high: '' }, args: [], timeoutMs: 900000 } }
    },
    adapters: {
      rtk: { enabled: true },
      'claude-mem': { enabled: false },
      caveman: { enabled: false, mode: 'opt-in' }
    },
    escalation: {
      enabled: true,
      policyPath: '.ai/policies/complexity.md',
      specsDir: 'docs/rods/specs',
      mode: 'advisory'
    },
    workflow: { mode: 'codex', maxIterations: 3, failOnSeverity: 'high', reviewContext: false }
  };
}

async function runAdapterChecks(
  adapter: IAdapterDefinition,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<ICommandCheck[]> {
  if (!adapter.binary) {
    return [];
  }

  const checks: ICommandCheck[] = [];

  if (adapter.versionArgs) {
    checks.push(await runCommand(adapter.binary, adapter.versionArgs, options));
  }

  if (adapter.healthArgs) {
    checks.push(await runCommand(adapter.binary, adapter.healthArgs, options));
  }

  return checks;
}

function runCommand(
  binary: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<ICommandCheck> {
  const command = formatCommand(binary, args);

  return new Promise((resolve) => {
    let done = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(binary, args, {
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timeout = setTimeout(() => {
      finish({ command, ok: false, error: 'timeout' });
      child.kill();
    }, options.timeoutMs ?? 5_000);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish({ command, ok: false, error: error.message });
    });
    child.on('close', (code) => {
      finish({
        command,
        ok: code === 0,
        output: firstLine(stdout || stderr),
        error: code === 0 ? undefined : firstLine(stderr || stdout)
      });
    });

    function finish(result: ICommandCheck): void {
      if (done) {
        return;
      }

      done = true;
      clearTimeout(timeout);
      resolve(result);
    }
  });
}

async function readCodexIntegrationState(
  root: string,
  options: IAdapterDoctorOptions = {}
): Promise<ITargetIntegrationState> {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const projectFiles = [
    path.join(root, 'AGENTS.md'),
    path.join(root, '.ai', 'adapters', 'rtk.md'),
    path.join(root, '.ai', 'adapters', 'claude-mem.md'),
    path.join(root, '.ai', 'adapters', 'caveman.md'),
    path.join(root, '.ai', 'adapters', 'codex', 'capabilities.md')
  ];
  const externalFiles = [
    path.join(root, 'RTK.md'),
    path.join(root, '.agents', 'skills', 'rtk', 'SKILL.md'),
    path.join(root, '.agents', 'skills', 'claude-mem', 'SKILL.md'),
    path.join(root, '.agents', 'skills', 'caveman', 'SKILL.md')
  ];
  const configText = await readText(path.join(codexHome, 'config.toml'));
  const hooksText = [await readText(path.join(codexHome, 'hooks.json')), await readText(path.join(codexHome, 'RTK.md'))].join('\n');
  const projectHooksText = await readText(path.join(root, '.codex', 'hooks.json'));
  const projectText = (await Promise.all(projectFiles.map((filePath) => readText(filePath)))).join('\n');
  const externalProjectText = (await Promise.all(externalFiles.map((filePath) => readText(filePath)))).join('\n');
  const externalText = [configText, hooksText, externalProjectText].join('\n');

  return {
    configText,
    hooksText: [hooksText, projectHooksText].join('\n'),
    projectText,
    externalText,
    allText: [externalText, projectText].join('\n')
  };
}

async function readClaudeIntegrationState(root: string): Promise<ITargetIntegrationState> {
  const projectFiles = [
    path.join(root, 'AGENTS.md'),
    path.join(root, 'CLAUDE.md'),
    path.join(root, '.ai', 'adapters', 'rtk.md'),
    path.join(root, '.ai', 'adapters', 'claude-mem.md'),
    path.join(root, '.ai', 'adapters', 'caveman.md'),
    path.join(root, '.ai', 'adapters', 'claude', 'capabilities.md')
  ];
  const projectText = (await Promise.all(projectFiles.map((filePath) => readText(filePath)))).join('\n');
  const hooksText = await readText(path.join(root, '.claude', 'settings.json'));

  return {
    configText: '',
    hooksText: [projectText, hooksText].join('\n'),
    projectText,
    externalText: projectText,
    allText: projectText
  };
}

async function writeLifecycleHooks(root: string, target: AdapterTarget): Promise<void> {
  const hookPath = target === 'codex'
    ? path.join(root, '.codex', 'hooks.json')
    : path.join(root, '.claude', 'settings.json');
  const current = await readJsonObject(hookPath);
  const hooks = isRecord(current.hooks) ? { ...current.hooks } : {};
  const command = `rods hook run --target ${target}`;
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'PostCompact'];
  for (const event of events) {
    const groups = Array.isArray(hooks[event]) ? hooks[event].filter((group) => !containsHookCommand(group, command)) : [];
    const group: Record<string, unknown> = {
      hooks: [{ type: 'command', command, timeout: event === 'UserPromptSubmit' ? 30 : 60, statusMessage: 'Rods escalation' }]
    };
    if (event === 'PreToolUse' || event === 'PostToolUse') group.matcher = 'Bash|apply_patch|Edit|Write';
    hooks[event] = [...groups, group];
  }
  await fs.mkdir(path.dirname(hookPath), { recursive: true });
  await fs.writeFile(hookPath, `${JSON.stringify({ ...current, hooks }, null, 2)}\n`);
}

function containsHookCommand(group: unknown, command: string): boolean {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return false;
  return group.hooks.some((hook) => isRecord(hook) && hook.command === command);
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
    return isRecord(value) ? value : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Cannot merge lifecycle hooks at ${filePath}: invalid JSON`);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function writeTargetHook(
  root: string,
  target: IAdapterTargetDefinition,
  options: IAdapterSyncOptions
): Promise<IFileWriteResult> {
  const hookPath = target.hookPath(root, options);
  const content = await target.projectionFn();
  const exists = await pathExists(hookPath);

  if (exists && !options.force) {
    const current = await fs.readFile(hookPath, 'utf8');

    if (current.includes('Rods SDK')) {
      return { path: hookPath, status: 'skipped' };
    }

    await fs.mkdir(path.dirname(hookPath), { recursive: true });
    await fs.writeFile(hookPath, `${current.trimEnd()}\n\n${content}`);
    return { path: hookPath, status: 'overwritten' };
  }

  await fs.mkdir(path.dirname(hookPath), { recursive: true });
  await fs.writeFile(hookPath, content);

  return { path: hookPath, status: exists ? 'overwritten' : 'created' };
}

async function renderHookTemplate(templateName: string): Promise<string> {
  const baseHook = await fs.readFile(getHookTemplatePath('base.md'), 'utf8');
  const template = await fs.readFile(getHookTemplatePath(templateName), 'utf8');

  return template.replace('{{baseHook}}', baseHook.trim());
}

function getHookTemplatePath(templateName: string): string {
  return path.join(fileURLToPath(new URL('../../templates/hooks', import.meta.url)), templateName);
}

async function readText(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

function detectTerms(text: string, terms: string[]): boolean {
  if (terms.length === 0) {
    return false;
  }

  const normalized = text.toLowerCase();
  return terms.some((term) => normalized.includes(term.toLowerCase()));
}

function detectConflict(_adapter: IAdapterDefinition, _state: ITargetIntegrationState): string {
  return 'none';
}

function formatCommand(binary: string | undefined, args: string[] | undefined): string {
  if (!binary) {
    return '';
  }

  return [binary, ...(args ?? [])].join(' ');
}

function firstLine(input: string): string | undefined {
  const trimmed = input.trim();

  if (!trimmed) {
    return undefined;
  }

  return trimmed.split(/\r?\n/, 1)[0]?.slice(0, 300);
}

function relativeFromRoot(root: string, targetPath: string): string {
  return path.relative(root, targetPath) || '.';
}

function formatSyncError(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'EACCES') {
    return '.agents/skills is read-only';
  }

  return error instanceof Error ? error.message : 'sync failed';
}
