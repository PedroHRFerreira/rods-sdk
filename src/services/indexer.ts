import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { ContextDatabase } from '../database/database.js';
import type { IChunkInput, IContextConfig, IIngestSummary, TContextKind } from '../types/context.js';
import { sha256 } from '../utils/hash.js';
import { buildIgnoreFilter } from '../utils/ignore.js';
import { detectKind } from '../utils/kind.js';
import { resolveProjectRoot } from '../utils/paths.js';
import { detectLanguage } from '../utils/language.js';
import { chunkContent } from './chunk.js';

const CHUNK_ALGORITHM_VERSION = 2;

export interface IIngestOptions {
  type?: TContextKind;
  scope?: string;
  projectRoot?: string;
}

export class IndexerService {
  constructor(
    private readonly db: ContextDatabase,
    private readonly config: IContextConfig
  ) {}

  async ingestPath(inputPath: string, options: IIngestOptions = {}): Promise<IIngestSummary> {
    const targetPath = path.resolve(inputPath);
    const stat = await fs.stat(targetPath);
    const projectRoot = resolveProjectRoot(targetPath, options.projectRoot);
    const scanRoot = projectRoot ?? (stat.isDirectory() ? targetPath : path.dirname(targetPath));
    const ignoreFilter = buildIgnoreFilter(scanRoot, this.config.ignore);
    const files = stat.isDirectory() ? await this.listFiles(scanRoot, ignoreFilter.patterns, targetPath) : [targetPath];
    const summary = createSummary();

    for (const filePath of files) {
      if (ignoreFilter.shouldIgnore(filePath)) {
        summary.ignored += 1;
        continue;
      }

      try {
        const result = await this.ingestFile(filePath, options);

        if (result.skipped) {
          summary.skipped += 1;
        } else {
          summary.indexed += 1;
          summary.chunks += result.chunks;
        }
      } catch (error) {
        summary.failed += 1;
        summary.errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return summary;
  }

  private async listFiles(root: string, ignorePatterns: string[], onlyWithin?: string): Promise<string[]> {
    const files = await fg('**/*', {
      absolute: true,
      cwd: root,
      dot: true,
      followSymbolicLinks: false,
      ignore: ignorePatterns,
      onlyFiles: true,
      unique: true
    });

    if (!onlyWithin) {
      return files;
    }

    return files.filter((filePath) => filePath === onlyWithin || filePath.startsWith(`${onlyWithin}${path.sep}`));
  }

  private async ingestFile(filePath: string, options: IIngestOptions): Promise<{ skipped: boolean; chunks: number }> {
    const buffer = await fs.readFile(filePath);

    if (isProbablyBinary(buffer)) {
      return { skipped: true, chunks: 0 };
    }

    const fileHash = sha256(buffer);
    const kind = detectKind(filePath, options.type);
    const scope = normalizeScope(options.scope);
    const cacheKey = `file:${filePath}:${kind}:v${CHUNK_ALGORITHM_VERSION}`;

    if (this.db.getCache(cacheKey, scope) === fileHash) {
      return { skipped: true, chunks: 0 };
    }

    const content = buffer.toString('utf8');
    const project = this.db.findProjectForPath(filePath);
    const language = detectLanguage(filePath);
    const chunks: IChunkInput[] = chunkContent(content, this.config.chunkSize, language).map((chunk) => ({
      projectId: project?.id ?? null,
      path: filePath,
      scope,
      kind,
      language,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      hash: chunk.hash,
      content: chunk.content
    }));

    const insertedChunks = this.db.replaceChunksForPath(filePath, chunks);
    this.db.setCache(cacheKey, fileHash, scope);

    return { skipped: false, chunks: insertedChunks };
  }
}

export function normalizeScope(scope: string | undefined): string {
  const normalized = (scope ?? 'general').trim();

  if (!normalized) {
    return 'general';
  }

  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error(`Invalid scope: ${scope}`);
  }

  return normalized;
}

function createSummary(): IIngestSummary {
  return {
    indexed: 0,
    skipped: 0,
    ignored: 0,
    failed: 0,
    chunks: 0,
    errors: []
  };
}

function isProbablyBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}
