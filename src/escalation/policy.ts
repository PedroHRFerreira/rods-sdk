import fs from 'node:fs/promises';
import path from 'node:path';
import type { IComplexityPolicy } from './types.js';

export const DEFAULT_COMPLEXITY_POLICY: IComplexityPolicy = {
  simple: { maxFiles: 2, maxLayers: 1 },
  medium: { maxFiles: 7, maxLayers: 2 },
  high: { minFiles: 8, minLayers: 3 },
  epicPhrases: ['sistema de', 'completo', 'geral', 'tudo'],
  dependencyRaisesTo: 'medium',
  layers: ['frontend', 'backend', 'src', 'server', 'app', 'packages', 'templates', 'docs', 'test']
};

function numberValue(value: string): number | undefined {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function parsePolicy(text: string): IComplexityPolicy {
  const policy: IComplexityPolicy = {
    simple: { ...DEFAULT_COMPLEXITY_POLICY.simple },
    medium: { ...DEFAULT_COMPLEXITY_POLICY.medium },
    high: { ...DEFAULT_COMPLEXITY_POLICY.high },
    epicPhrases: [...DEFAULT_COMPLEXITY_POLICY.epicPhrases],
    dependencyRaisesTo: DEFAULT_COMPLEXITY_POLICY.dependencyRaisesTo,
    layers: [...DEFAULT_COMPLEXITY_POLICY.layers]
  };
  const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---/m)?.[1];

  if (!frontmatter) {
    throw new Error('Complexity policy must contain YAML frontmatter');
  }

  let section: keyof IComplexityPolicy | undefined;
  let listKey: 'epicPhrases' | 'layers' | undefined;
  for (const rawLine of frontmatter.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^(simple|medium|high):\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1] as keyof IComplexityPolicy;
      listKey = undefined;
      continue;
    }
    const listMatch = line.match(/^(epicPhrases|layers):\s*$/);
    if (listMatch) {
      section = undefined;
      listKey = listMatch[1] as typeof listKey;
      const activeListKey = listKey;
      if (activeListKey) policy[activeListKey] = [];
      continue;
    }
    const item = line.match(/^-\s*(.+)$/);
    if (item && listKey) {
      policy[listKey].push(stripQuotes(item[1]));
      continue;
    }
    const pair = line.match(/^([A-Za-z]+):\s*(.+)$/);
    if (!pair) continue;
    const [, key, rawValue] = pair;
    if (section && ['simple', 'medium', 'high'].includes(section)) {
      const value = numberValue(rawValue);
      if (value === undefined || !['maxFiles', 'minFiles', 'maxLayers', 'minLayers'].includes(key)) {
        throw new Error(`Invalid complexity policy value: ${key}`);
      }
      (policy[section] as Record<string, number | undefined>)[key] = value;
      continue;
    }
    if (key === 'dependencyRaisesTo') {
      const value = stripQuotes(rawValue);
      if (!['simple', 'medium', 'high'].includes(value)) throw new Error('Invalid dependencyRaisesTo');
      policy.dependencyRaisesTo = value as IComplexityPolicy['dependencyRaisesTo'];
      continue;
    }
    if (key === 'epicPhrases' || key === 'layers') {
      const inline = rawValue.trim().replace(/^\[|\]$/g, '');
      policy[key] = inline ? inline.split(',').map(stripQuotes) : [];
    }
  }
  return policy;
}

export async function loadComplexityPolicy(root: string, policyPath = '.ai/policies/complexity.md'): Promise<IComplexityPolicy> {
  try {
    return parsePolicy(await fs.readFile(path.join(root, policyPath), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_COMPLEXITY_POLICY;
    throw error;
  }
}

export { parsePolicy };
