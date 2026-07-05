import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type FileWriteStatus = 'created' | 'overwritten' | 'skipped';

export interface IFileWriteResult {
  path: string;
  status: FileWriteStatus;
}

export interface IInitProjectOptions {
  force?: boolean;
  projectName?: string;
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
    template: 'ai/adapters/rtk.md.tpl',
    destination: '.ai/adapters/rtk.md'
  }
];

export async function initProject(root: string, options: IInitProjectOptions = {}): Promise<IFileWriteResult[]> {
  const resolvedRoot = path.resolve(root);
  const variables = {
    projectName: options.projectName ?? path.basename(resolvedRoot)
  };

  const results: IFileWriteResult[] = [];

  for (const mapping of INIT_TEMPLATES) {
    results.push(
      await writeTemplateFile(mapping.template, path.join(resolvedRoot, mapping.destination), variables, {
        force: options.force
      })
    );
  }
  return results;
}

export async function writeTemplateFile(
  templatePath: string,
  destinationPath: string,
  variables: Record<string, string>,
  options: { force?: boolean } = {}
): Promise<IFileWriteResult> {
  const content = renderTemplate(await readTemplate(templatePath), variables);
  const exists = await pathExists(destinationPath);

  if (exists && !options.force) {
    return { path: destinationPath, status: 'skipped' };
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

function getTemplatePath(templatePath: string): string {
  return path.join(getTemplatesRoot(), templatePath);
}

function getTemplatesRoot(): string {
  return fileURLToPath(new URL('../../templates/consumer', import.meta.url));
}

function renderTemplate(content: string, variables: Record<string, string>): string {
  return content.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key: string) => variables[key] ?? '');
}
