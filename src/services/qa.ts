import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ContextDatabase } from '../database/database.js';
import type { IQaEntry, IQaFile, IQaSearchResult, TQaPolicy } from '../types/context.js';

const STOPWORDS = new Set(['a','as','o','os','de','da','das','do','dos','e','em','um','uma','para','por','que','the','a','an','of','to','and','in','is']);
export const QA_NORMALIZATION_VERSION = 1;
export const DEFAULT_QA_THRESHOLD = 0.75;
const CONCEPTUAL_FINGERPRINT = 'conceptual:v1';

export function normalizeQuestion(question: string): string {
  return question.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu)?.filter((word) => !STOPWORDS.has(word)).join(' ') ?? '';
}

export function questionHash(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}

export function gitFingerprint(root: string): string {
  const run = (args: string[]) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }); } catch { return ''; } };
  const head = run(['rev-parse', 'HEAD']).trim() || 'no-head';
  const tracked = run(['diff', '--no-ext-diff', '--binary', 'HEAD']);
  const untracked = run(['ls-files', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean).sort().map((file) => {
    try { return `${file}:${createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')}`; } catch { return file; }
  }).join('\n');
  return createHash('sha256').update(`${head}\0${tracked}\0${untracked}`).digest('hex');
}

function fileHash(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function prepareQaValidity(root: string, policy: TQaPolicy, requestedFiles: string[] = []): { fingerprint: string; files: IQaFile[] } {
  if (policy !== 'files') {
    if (requestedFiles.length) throw new Error(`--files is only valid with policy files`);
    return { fingerprint: policy === 'conceptual' ? CONCEPTUAL_FINGERPRINT : gitFingerprint(root), files: [] };
  }
  if (!requestedFiles.length) throw new Error('Policy files requires at least one file');
  const realRoot = fs.realpathSync(root);
  const files = requestedFiles.map((requested) => {
    const absolute = path.resolve(realRoot, requested);
    let realFile: string;
    try { realFile = fs.realpathSync(absolute); } catch { throw new Error(`Q&A dependency does not exist: ${requested}`); }
    const relative = path.relative(realRoot, realFile);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Q&A dependency is outside the project: ${requested}`);
    if (!fs.statSync(realFile).isFile()) throw new Error(`Q&A dependency is not a regular file: ${requested}`);
    return { filePath: relative.split(path.sep).join('/'), fileHash: fileHash(realFile) };
  }).sort((left, right) => left.filePath.localeCompare(right.filePath));
  if (new Set(files.map((file) => file.filePath)).size !== files.length) throw new Error('Q&A dependencies contain duplicate paths');
  const fingerprint = `files:${createHash('sha256').update(files.map((file) => `${file.filePath}\0${file.fileHash}`).join('\0')).digest('hex')}`;
  return { fingerprint, files };
}

export function createQaFreshnessChecker(root: string): (entry: IQaEntry) => boolean {
  let repositoryFingerprint: string | undefined;
  const hashes = new Map<string, string | null>();
  let realRoot: string;
  try { realRoot = fs.realpathSync(root); } catch { realRoot = path.resolve(root); }
  return (entry) => {
    if (entry.policy === 'conceptual') return true;
    if (entry.policy === 'repository') { repositoryFingerprint ??= gitFingerprint(root); return entry.fingerprint === repositoryFingerprint; }
    if (!entry.files.length) return false;
    return entry.files.every((file) => {
      const absolute = path.resolve(realRoot, file.filePath);
      let realFile: string;
      try { realFile = fs.realpathSync(absolute); } catch { return false; }
      const relative = path.relative(realRoot, realFile);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
      if (!hashes.has(realFile)) { try { hashes.set(realFile, fs.statSync(realFile).isFile() ? fileHash(realFile) : null); } catch { hashes.set(realFile, null); } }
      return hashes.get(realFile) === file.fileHash;
    });
  };
}

export function isQaFresh(entry: IQaEntry, root: string): boolean {
  return createQaFreshnessChecker(root)(entry);
}

function overlap(left: string, right: string): number {
  const a = new Set(left.split(' ').filter(Boolean));
  const b = new Set(right.split(' ').filter(Boolean));
  if (!a.size || !b.size) return 0;
  const common = [...a].filter((term) => b.has(term)).length;
  return common / Math.max(a.size, b.size);
}

export function searchQa(db: ContextDatabase, projectId: number, question: string, root: string, threshold = DEFAULT_QA_THRESHOLD): IQaSearchResult {
  const normalized = normalizeQuestion(question);
  const isFresh = createQaFreshnessChecker(root);
  const exact = db.findQaExact(projectId, questionHash(normalized));
  const freshExact = exact.find(isFresh);
  if (freshExact) { db.touchQa(freshExact.id); return { status: 'hit', match: 'exact', confidence: 1, entry: { ...freshExact, hitCount: freshExact.hitCount + 1, lastUsedAt: new Date().toISOString() } }; }
  if (exact.length) return { status: 'stale', match: 'exact', confidence: 1, entry: exact[0] };
  const ranked = db.findQaLexical(projectId, normalized).map((entry) => ({ entry, confidence: overlap(normalized, entry.normalizedQuestion) })).sort((a,b) => b.confidence - a.confidence);
  const eligible = ranked.filter((candidate) => candidate.confidence >= threshold);
  const fresh = eligible.find((candidate) => isFresh(candidate.entry));
  if (fresh) { db.touchQa(fresh.entry.id); return { status: 'hit', match: 'lexical', confidence: fresh.confidence, entry: { ...fresh.entry, hitCount: fresh.entry.hitCount + 1, lastUsedAt: new Date().toISOString() } }; }
  const candidate = eligible[0];
  if (!candidate) return { status: 'miss', match: null, confidence: ranked[0]?.confidence ?? 0, entry: null };
  return { status: 'stale', match: 'lexical', confidence: candidate.confidence, entry: candidate.entry };
}

export function qaStats(entries: IQaEntry[], root: string) {
  const isFresh = createQaFreshnessChecker(root);
  const fresh = entries.filter(isFresh);
  const stale = entries.filter((entry) => !isFresh(entry));
  const tokens = (items: IQaEntry[]) => items.reduce((sum, entry) => sum + (entry.sourceTokens == null ? 0 : entry.sourceTokens * entry.hitCount), 0);
  const hits = (items: IQaEntry[]) => items.reduce((sum, entry) => sum + entry.hitCount, 0);
  return { hits: hits(fresh), tokensSaved: tokens(fresh), freshEntries: fresh.length, freshHits: hits(fresh), freshTokensSaved: tokens(fresh), staleEntries: stale.length, staleHitsExcluded: hits(stale), staleTokensExcluded: tokens(stale), tokenCoverageHits: fresh.reduce((sum, entry) => sum + (entry.sourceTokens == null ? 0 : entry.hitCount), 0) };
}

export function staleQaIds(entries: IQaEntry[], root: string, olderThanDays?: number): number[] {
  const cutoff = olderThanDays === undefined ? null : Date.now() - olderThanDays * 86_400_000;
  const isFresh = createQaFreshnessChecker(root);
  return entries.filter((entry) => !isFresh(entry) && (cutoff === null || Date.parse(entry.lastUsedAt) < cutoff)).map((entry) => entry.id);
}
