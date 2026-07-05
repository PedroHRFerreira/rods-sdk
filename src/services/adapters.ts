import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyFileIfAllowed, pathExists, writeTemplateFile, type IFileWriteResult } from './scaffold.js';

export const ADAPTER_NAMES = ['rtk', 'claude-mem', 'caveman'] as const;

export type AdapterName = (typeof ADAPTER_NAMES)[number];
export type AdapterTarget = 'codex';

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
  adapters: Record<AdapterName, IAdapterState>;
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
  files: IFileWriteResult[];
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

export function listAdapters(): IAdapterDefinition[] {
  return ADAPTER_NAMES.map((name) => ADAPTERS[name]);
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
  options: { force?: boolean } = {}
): Promise<IAdapterSyncResult> {
  if (target !== 'codex') {
    throw new Error(`Unsupported adapter target: ${target}`);
  }

  const resolvedRoot = path.resolve(root);
  const sourceSkillsDir = path.join(resolvedRoot, '.ai', 'skills');
  const destinationSkillsDir = path.join(resolvedRoot, '.agents', 'skills');
  const files: IFileWriteResult[] = [];

  if (!(await pathExists(sourceSkillsDir))) {
    return { target, files };
  }

  const entries = await fs.readdir(sourceSkillsDir, { withFileTypes: true });

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

  return { target, files };
}

export async function doctorAdapters(
  root: string,
  options: IAdapterDoctorOptions = {}
): Promise<IAdapterDoctorReport[]> {
  const target = options.target ?? 'codex';

  if (target !== 'codex') {
    throw new Error(`Unsupported adapter target: ${target}`);
  }

  const resolvedRoot = path.resolve(root);
  const config = await loadGovernanceConfig(resolvedRoot);
  const integrationState = await readCodexIntegrationState(resolvedRoot, options.codexHome);
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
    adapters: {
      ...defaults.adapters,
      ...(parsed.adapters ?? {})
    }
  };
}

async function saveGovernanceConfig(root: string, config: IGovernanceConfig): Promise<string> {
  const configPath = path.join(root, '.ai', 'config.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

function createDefaultConfig(root: string): IGovernanceConfig {
  return {
    version: 1,
    project: path.basename(root),
    source: '.ai',
    execution: {
      mode: 'cli',
      apiEnabled: false
    },
    defaultTarget: 'codex',
    adapters: {
      rtk: { enabled: true },
      'claude-mem': { enabled: false },
      caveman: { enabled: false, mode: 'opt-in' }
    }
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

interface ICodexIntegrationState {
  configText: string;
  hooksText: string;
  projectText: string;
  externalText: string;
  allText: string;
}

async function readCodexIntegrationState(root: string, codexHomeInput?: string): Promise<ICodexIntegrationState> {
  const codexHome = codexHomeInput ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const projectFiles = [
    path.join(root, 'AGENTS.md'),
    path.join(root, '.ai', 'adapters', 'rtk.md'),
    path.join(root, '.ai', 'adapters', 'claude-mem.md'),
    path.join(root, '.ai', 'adapters', 'caveman.md')
  ];
  const externalFiles = [
    path.join(root, 'RTK.md'),
    path.join(root, '.agents', 'skills', 'rtk', 'SKILL.md'),
    path.join(root, '.agents', 'skills', 'claude-mem', 'SKILL.md'),
    path.join(root, '.agents', 'skills', 'caveman', 'SKILL.md')
  ];
  const configText = await readText(path.join(codexHome, 'config.toml'));
  const hooksText = await readText(path.join(codexHome, 'hooks.json'));
  const projectText = (await Promise.all(projectFiles.map((filePath) => readText(filePath)))).join('\n');
  const externalProjectText = (await Promise.all(externalFiles.map((filePath) => readText(filePath)))).join('\n');
  const externalText = [configText, hooksText, externalProjectText].join('\n');

  return {
    configText,
    hooksText,
    projectText,
    externalText,
    allText: [externalText, projectText].join('\n')
  };
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

function detectConflict(_adapter: IAdapterDefinition, _state: ICodexIntegrationState): string {
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
