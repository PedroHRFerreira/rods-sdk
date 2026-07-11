import path from 'node:path';
import type { Command } from 'commander';
import { ContextDatabase } from '../database/database.js';
import { loadConfig } from '../services/config.js';
import { createQaFreshnessChecker, normalizeQuestion, prepareQaValidity, qaStats, questionHash, searchQa, staleQaIds } from '../services/qa.js';
import type { IProject, TQaPolicy } from '../types/context.js';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { value += chunk; });
    process.stdin.on('end', () => resolve(value.trim()));
    process.stdin.on('error', reject);
  });
}

function resolveProject(db: ContextDatabase, root: string, name?: string): IProject {
  if (name) {
    const project = db.listProjects().find((candidate) => candidate.name === name);
    if (!project) throw new Error(`Unknown project: ${name}`);
    return project;
  }
  return db.findProjectForPath(root) ?? db.upsertProject(path.basename(root), root);
}

function parsePolicy(value: string): TQaPolicy {
  if (value === 'conceptual' || value === 'files' || value === 'repository') return value;
  throw new Error('--policy must be conceptual, files, or repository');
}

function parseFiles(value?: string): string[] {
  if (value === undefined) return [];
  const files = value.split(',').map((file) => file.trim()).filter(Boolean);
  if (!files.length) throw new Error('--files must contain at least one path');
  return files;
}

export function registerQaCommand(program: Command): void {
  const qa = program.command('qa').description('Store and reuse project Q&A with lexical matching');
  qa.command('store')
    .requiredOption('--question <text>', 'question to cache')
    .requiredOption('--answer <text>', 'full answer or - to read stdin')
    .requiredOption('--policy <policy>', 'conceptual, files, or repository')
    .option('--files <paths>', 'comma-separated dependencies for policy files')
    .option('--summary <text>', 'compact answer; defaults to the full answer')
    .option('--tokens <count>', 'known source token count')
    .option('--project <name>', 'registered project name')
    .option('--root <path>', 'project root', '.')
    .option('--json', 'emit JSON')
    .action(async (options: { question: string; answer: string; policy: string; files?: string; summary?: string; tokens?: string; project?: string; root: string; json?: boolean }) => {
      const root = path.resolve(options.root);
      const db = new ContextDatabase(loadConfig());
      try {
        const project = resolveProject(db, root, options.project);
        const policy = parsePolicy(options.policy);
        const validity = prepareQaValidity(project.root, policy, parseFiles(options.files));
        const answer = options.answer === '-' ? await readStdin() : options.answer;
        if (!answer) throw new Error('Answer cannot be empty');
        const normalized = normalizeQuestion(options.question);
        if (!normalized) throw new Error('Question has no indexable terms');
        const tokens = options.tokens === undefined ? undefined : Number.parseInt(options.tokens, 10);
        if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens < 0)) throw new Error('--tokens must be a non-negative integer');
        const entry = db.storeQa({ projectId: project.id, question: options.question, normalized, hash: questionHash(normalized), policy, fingerprint: validity.fingerprint, files: validity.files, summary: options.summary ?? answer, fullAnswer: answer, tokens });
        console.log(options.json ? JSON.stringify(entry) : `id=${entry.id} project=${project.name} stored=true`);
      } finally { db.close(); }
    });

  qa.command('search').argument('<question>').option('--project <name>').option('--root <path>', 'project root', '.').option('--threshold <number>', 'lexical overlap threshold', '0.75').option('--json').action((question: string, options: { project?: string; root: string; threshold: string; json?: boolean }) => {
    const root = path.resolve(options.root); const db = new ContextDatabase(loadConfig());
    try {
      const project = resolveProject(db, root, options.project); const threshold = Number(options.threshold);
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('--threshold must be between 0 and 1');
      const result = searchQa(db, project.id, question, project.root, threshold);
      if (options.json) console.log(JSON.stringify(result));
      else { console.log(`status=${result.status} match=${result.match ?? 'none'} confidence=${result.confidence.toFixed(2)}`); if (result.entry) console.log(result.entry.summary); }
      if (result.status === 'miss') process.exitCode = 2;
    } finally { db.close(); }
  });

  qa.command('list').option('--project <name>').option('--root <path>', 'project root', '.').option('--stale', 'show only stale entries').option('--json').action((options: { project?: string; root: string; stale?: boolean; json?: boolean }) => {
    const root = path.resolve(options.root); const db = new ContextDatabase(loadConfig());
    try {
      const project = resolveProject(db, root, options.project);
      const isFresh = createQaFreshnessChecker(project.root); const entries = db.listQa(project.id).map((entry) => ({ ...entry, stale: !isFresh(entry) })).filter((entry) => !options.stale || entry.stale);
      if (options.json) console.log(JSON.stringify(entries)); else if (!entries.length) console.log('entries=0'); else for (const entry of entries) console.log(`id=${entry.id} policy=${entry.policy} hits=${entry.hitCount} stale=${entry.stale} files=${entry.files.map((file) => file.filePath).join(',')} question=${JSON.stringify(entry.rawQuestion)}`);
    } finally { db.close(); }
  });

  qa.command('invalidate').argument('<id>').action((rawId: string) => { const id = Number.parseInt(rawId, 10); if (!Number.isSafeInteger(id)) throw new Error('id must be an integer'); const db = new ContextDatabase(loadConfig()); try { const removed = db.invalidateQa(id); console.log(`invalidated=${removed}`); if (!removed) process.exitCode = 1; } finally { db.close(); } });

  qa.command('reclassify').argument('<id>').requiredOption('--policy <policy>').option('--files <paths>').option('--project <name>').option('--root <path>', 'project root', '.').option('--json').action((rawId: string, options: { policy: string; files?: string; project?: string; root: string; json?: boolean }) => {
    const id = Number.parseInt(rawId, 10); if (!Number.isSafeInteger(id)) throw new Error('id must be an integer');
    const root = path.resolve(options.root); const db = new ContextDatabase(loadConfig());
    try { const project = resolveProject(db, root, options.project); const entry = db.getQaById(id); if (!entry || entry.projectId !== project.id) throw new Error(`Unknown Q&A entry for project ${project.name}: ${id}`); const policy = parsePolicy(options.policy); const validity = prepareQaValidity(project.root, policy, parseFiles(options.files)); const updated = db.reclassifyQa(id, policy, validity.fingerprint, validity.files); console.log(options.json ? JSON.stringify(updated) : `id=${id} policy=${policy} reclassified=true`); } finally { db.close(); }
  });

  qa.command('prune').requiredOption('--stale', 'only prune entries that are currently stale').option('--project <name>').option('--root <path>', 'project root', '.').option('--older-than <days>', 'only entries unused for this many days').option('--dry-run').option('--json').action((options: { stale: boolean; project?: string; root: string; olderThan?: string; dryRun?: boolean; json?: boolean }) => {
    const root = path.resolve(options.root); const db = new ContextDatabase(loadConfig());
    try { const project = resolveProject(db, root, options.project); let days: number | undefined; if (options.olderThan !== undefined) { days = Number(options.olderThan); if (!Number.isInteger(days) || days < 0) throw new Error('--older-than must be a non-negative integer'); } const ids = staleQaIds(db.listQa(project.id), project.root, days); const result = db.pruneQa(ids, options.dryRun); const output = { project: project.name, dryRun: options.dryRun ?? false, selectedIds: ids, removedEntries: options.dryRun ? 0 : result.entries, selectedEntries: result.entries, orphanAnswers: result.orphanAnswers, logicalBytes: result.logicalBytes }; if (options.json) console.log(JSON.stringify(output)); else for (const [key, value] of Object.entries(output)) console.log(`${key}=${Array.isArray(value) ? value.join(',') : value}`); } finally { db.close(); }
  });

  qa.command('stats').option('--project <name>').option('--root <path>', 'project root', '.').option('--json').action((options: { project?: string; root: string; json?: boolean }) => { const root = path.resolve(options.root); const db = new ContextDatabase(loadConfig()); try { const project = resolveProject(db, root, options.project); const stats = qaStats(db.listQa(project.id), project.root); if (options.json) console.log(JSON.stringify(stats)); else for (const [key, value] of Object.entries(stats)) console.log(`${key}=${value}`); } finally { db.close(); } });
}
