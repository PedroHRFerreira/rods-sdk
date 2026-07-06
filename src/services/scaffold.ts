import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../utils/hash.js';

export type FileWriteStatus =
  | 'created'
  | 'overwritten'
  | 'skipped'
  | 'unchanged'
  | 'customized'
  | 'would-create'
  | 'would-overwrite'
  | 'would-skip-customized';

export interface IFileWriteResult {
  path: string;
  status: FileWriteStatus;
  upstreamChanged?: boolean;
}

export interface IInitProjectOptions {
  force?: boolean;
  projectName?: string;
  dryRun?: boolean;
}

interface ITemplateMapping {
  template: string;
  destination: string;
}

const INIT_TEMPLATES: ITemplateMapping[] = [
  { template: 'AGENTS.md.tpl', destination: 'AGENTS.md' },
  { template: 'ai/config.json.tpl', destination: '.ai/config.json' },
  { template: 'ai/constitution.md.tpl', destination: '.ai/constitution.md' },
  {
    template: 'ai/skills/context-search-first/SKILL.md.tpl',
    destination: '.ai/skills/context-search-first/SKILL.md'
  },
  {
    template: 'ai/skills/review/SKILL.md.tpl',
    destination: '.ai/skills/review/SKILL.md'
  },
  {
    template: 'ai/skills/architecture/SKILL.md.tpl',
    destination: '.ai/skills/architecture/SKILL.md'
  },
  {
    template: 'ai/skills/quality/SKILL.md.tpl',
    destination: '.ai/skills/quality/SKILL.md'
  },
  {
    template: 'ai/adapters/rtk.md.tpl',
    destination: '.ai/adapters/rtk.md'
  }
];

export async function initProject(root: string, options: IInitProjectOptions = {}): Promise<IFileWriteResult[]> {
  const resolvedRoot = path.resolve(root);
  const stack = await detectProjectStack(resolvedRoot);
  const variables = {
    projectName: options.projectName ?? path.basename(resolvedRoot),
    stackLabel: stack.label,
    frontendReadingMapRow: stack.hasFrontend
      ? '| frontend / styles | `.ai/skills/architecture/SKILL.md`, `.ai/skills/quality/SKILL.md` |'
      : ''
  };

  const results: IFileWriteResult[] = [];

  for (const mapping of INIT_TEMPLATES) {
    const destinationPath = path.join(resolvedRoot, mapping.destination);
    results.push(
      await writeTemplateFile(mapping.template, destinationPath, variables, {
        force: options.force,
        dryRun: options.dryRun
      })
    );
  }

  if (!options.dryRun) {
    await updateTemplateMetadata(resolvedRoot, results);
  }

  return results;
}

export async function writeTemplateFile(
  templatePath: string,
  destinationPath: string,
  variables: Record<string, string>,
  options: { force?: boolean; dryRun?: boolean } = {}
): Promise<IFileWriteResult> {
  const content = renderTemplate(await readTemplate(templatePath), variables);
  const exists = await pathExists(destinationPath);

  if (exists && !options.force) {
    return { path: destinationPath, status: 'skipped' };
  }

  if (options.dryRun) {
    return { path: destinationPath, status: exists ? 'would-overwrite' : 'would-create' };
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.writeFile(destinationPath, content);

  return { path: destinationPath, status: exists ? 'overwritten' : 'created' };
}

export async function copyFileIfAllowed(
  sourcePath: string,
  destinationPath: string,
  options: { force?: boolean } = {}
): Promise<IFileWriteResult> {
  const exists = await pathExists(destinationPath);

  if (exists && !options.force) {
    return { path: destinationPath, status: 'skipped' };
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.copyFile(sourcePath, destinationPath);

  return { path: destinationPath, status: exists ? 'overwritten' : 'created' };
}

export async function upgradeProject(root: string, options: IInitProjectOptions = {}): Promise<IFileWriteResult[]> {
  const resolvedRoot = path.resolve(root);
  const stack = await detectProjectStack(resolvedRoot);
  const variables = {
    projectName: options.projectName ?? path.basename(resolvedRoot),
    stackLabel: stack.label,
    frontendReadingMapRow: stack.hasFrontend
      ? '| frontend / styles | `.ai/skills/architecture/SKILL.md`, `.ai/skills/quality/SKILL.md` |'
      : ''
  };
  const metadata = await readTemplateMetadata(resolvedRoot);
  const results: IFileWriteResult[] = [];

  for (const mapping of INIT_TEMPLATES) {
    const destinationPath = path.join(resolvedRoot, mapping.destination);
    const content = renderTemplate(await readTemplate(mapping.template), variables);
    const nextHash = sha256(content);
    const previousHash = metadata[mapping.destination];
    const exists = await pathExists(destinationPath);

    if (!exists) {
      results.push(await writeUpgradeResult(destinationPath, content, 'created', 'would-create', options));
      continue;
    }

    const currentHash = sha256(await fs.readFile(destinationPath));

    if (currentHash === nextHash) {
      results.push({ path: destinationPath, status: 'unchanged' });
      continue;
    }

    if (options.force || (previousHash && currentHash === previousHash)) {
      results.push(await writeUpgradeResult(destinationPath, content, 'overwritten', 'would-overwrite', options));
      continue;
    }

    results.push({
      path: destinationPath,
      status: options.dryRun ? 'would-skip-customized' : 'customized',
      upstreamChanged: Boolean(previousHash && previousHash !== nextHash)
    });
  }

  if (!options.dryRun) {
    await updateTemplateMetadata(resolvedRoot, results);
  }

  return results;
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readTemplate(templatePath: string): Promise<string> {
  return fs.readFile(getTemplatePath(templatePath), 'utf8');
}

export function getTemplatePath(templatePath: string): string {
  return path.join(getTemplatesRoot(), templatePath);
}

export function getTemplatesRoot(): string {
  return fileURLToPath(new URL('../../templates/consumer', import.meta.url));
}

function renderTemplate(content: string, variables: Record<string, string>): string {
  return content.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key: string) => variables[key] ?? '');
}

async function writeUpgradeResult(
  destinationPath: string,
  content: string,
  appliedStatus: FileWriteStatus,
  dryRunStatus: FileWriteStatus,
  options: IInitProjectOptions
): Promise<IFileWriteResult> {
  if (options.dryRun) {
    return { path: destinationPath, status: dryRunStatus };
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.writeFile(destinationPath, content);

  return { path: destinationPath, status: appliedStatus };
}

async function updateTemplateMetadata(root: string, results: IFileWriteResult[]): Promise<void> {
  const configPath = path.join(root, '.ai', 'config.json');

  if (!(await pathExists(configPath))) {
    return;
  }

  const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
  const generatedTemplates = {
    ...((config.generatedTemplates as Record<string, string> | undefined) ?? {})
  };

  for (const result of results) {
    if (result.status !== 'created' && result.status !== 'overwritten' && result.status !== 'unchanged') {
      continue;
    }

    const relativePath = path.relative(root, result.path);

    if (await pathExists(result.path)) {
      generatedTemplates[relativePath] = sha256(await fs.readFile(result.path));
    }
  }

  config.generatedTemplates = generatedTemplates;
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function readTemplateMetadata(root: string): Promise<Record<string, string>> {
  const configPath = path.join(root, '.ai', 'config.json');

  if (!(await pathExists(configPath))) {
    return {};
  }

  const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as { generatedTemplates?: Record<string, string> };

  return config.generatedTemplates ?? {};
}

async function detectProjectStack(root: string): Promise<{ label: string; hasFrontend: boolean }> {
  const packageJsonPath = path.join(root, 'package.json');
  const goModPath = path.join(root, 'go.mod');
  const packageJson = await readJsonFile(packageJsonPath);
  const packageText = packageJson ? JSON.stringify(packageJson).toLowerCase() : '';
  const hasGo = await pathExists(goModPath);
  const hasNuxt = packageText.includes('"nuxt"') || (await pathExists(path.join(root, 'nuxt.config.ts')));
  const hasNext = packageText.includes('"next"') || (await pathExists(path.join(root, 'next.config.js')));
  const hasVue = packageText.includes('"vue"') || hasNuxt;
  const hasReact = packageText.includes('"react"') || hasNext;

  if (hasNuxt) {
    return { label: 'Nuxt/Vue TypeScript', hasFrontend: true };
  }

  if (hasNext) {
    return { label: 'Next.js/React TypeScript', hasFrontend: true };
  }

  if (hasVue) {
    return { label: 'Vue TypeScript', hasFrontend: true };
  }

  if (hasReact) {
    return { label: 'React TypeScript', hasFrontend: true };
  }

  if (hasGo) {
    return { label: 'Go', hasFrontend: false };
  }

  return { label: 'Generic', hasFrontend: false };
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}
