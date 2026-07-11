import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { DEFAULT_COMPLEXITY_POLICY } from './policy.js';
import type { IClassificationInput, IClassificationResult, IComplexityPolicy, ComplexityLevel } from './types.js';

function gitFiles(root: string): string[] {
  try {
    const output = execFileSync('git', ['diff', '--name-only'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return output.split(/\r?\n/).map((file) => file.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function layersFor(files: string[], policy: IComplexityPolicy): Set<string> {
  const layers = new Set<string>();
  for (const file of files) {
    const normalized = file.replaceAll('\\', '/');
    const first = normalized.split('/')[0];
    const configured = policy.layers.find((layer) => first === layer || normalized.startsWith(`${layer}/`));
    layers.add(configured ?? (first || '.'));
  }
  return layers;
}

function maxLevel(left: ComplexityLevel, right: ComplexityLevel): ComplexityLevel {
  const order: ComplexityLevel[] = ['simple', 'medium', 'high'];
  return order[Math.max(order.indexOf(left), order.indexOf(right))];
}

export function classifyTask(input: IClassificationInput): IClassificationResult {
  const policy = input.policy ?? DEFAULT_COMPLEXITY_POLICY;
  const root = input.root ?? process.cwd();
  const files = input.preExecution
    ? []
    : [...new Set((input.files?.length ? input.files : gitFiles(root)).filter(Boolean))];
  const task = input.task.trim();
  const lower = task.toLocaleLowerCase();
  const layers = layersFor(files, policy);
  const reasons: string[] = [];
  const epic = policy.epicPhrases.some((phrase) => lower.includes(phrase.toLocaleLowerCase()));
  const dependencyNew = /\b(dependenc|dependência|package\.json|pnpm|npm install|import novo|external api)\b/i.test(task) ||
    files.some((file) => /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(file));
  let level: ComplexityLevel = 'simple';
  if (files.length > (policy.simple.maxFiles ?? 2) || layers.size > (policy.simple.maxLayers ?? 1)) {
    level = 'medium';
    reasons.push(`escopo estimado: ${files.length} arquivo(s), ${layers.size} camada(s)`);
  } else {
    reasons.push(`escopo pequeno: ${files.length} arquivo(s), ${layers.size} camada(s)`);
  }
  if (dependencyNew) {
    level = maxLevel(level, policy.dependencyRaisesTo);
    reasons.push('há sinal de dependência externa');
  }
  if (files.length >= (policy.high.minFiles ?? 8) || layers.size >= (policy.high.minLayers ?? 3)) {
    level = 'high';
    reasons.push('escopo ultrapassa o limiar Alto');
  }
  if (epic) {
    level = 'high';
    reasons.push('gatilho Epic encontrado na demanda');
  }
  const needsHumanReview = !task || (!input.preExecution && files.length === 0 && !epic && !dependencyNew);
  if (needsHumanReview) {
    level = maxLevel(level, 'medium');
    reasons.push('faltam sinais suficientes para confiança alta');
  }
  const confidence = needsHumanReview ? 0.55 : level === 'high' ? 0.95 : level === 'medium' ? 0.8 : 0.9;
  return {
    level,
    confidence,
    reasons,
    estimatedFiles: files.length,
    estimatedLayers: layers.size,
    dependencyNew,
    epic,
    needsHumanReview,
    planningRequired: level === 'high'
  };
}

export function filesFromArgument(value?: string): string[] | undefined {
  if (!value) return undefined;
  return value.split(',').map((file) => path.normalize(file.trim())).filter(Boolean);
}
