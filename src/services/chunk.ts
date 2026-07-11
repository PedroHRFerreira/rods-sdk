import type { IContentChunk } from '../types/context.js';
import { sha256 } from '../utils/hash.js';

type TChunkFamily = 'brace' | 'indent' | 'blank';

const BRACE_LANGUAGES = new Set(['javascript', 'typescript', 'go', 'css', 'scss']);

export function chunkContent(content: string, chunkSize: number, language?: string): IContentChunk[] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error('chunkSize must be a positive integer');
  }

  const lines = content.length > 0 ? content.split(/\r?\n/) : [''];
  const chunks: IContentChunk[] = [];
  const family = getChunkFamily(language);
  const tolerance = Math.min(20, Math.floor(chunkSize * 0.25));

  for (let index = 0; index < lines.length;) {
    const targetIndex = Math.min(index + chunkSize, lines.length);
    const endIndex = targetIndex < lines.length
      ? findBoundary(lines, index, targetIndex, tolerance, family)
      : targetIndex;
    const chunkLines = lines.slice(index, endIndex);
    const chunkText = chunkLines.join('\n');

    chunks.push({
      startLine: index + 1,
      endLine: index + chunkLines.length,
      content: chunkText,
      hash: sha256(chunkText)
    });

    index = endIndex;
  }

  return chunks;
}

function getChunkFamily(language?: string): TChunkFamily {
  if (language === 'python') {
    return 'indent';
  }

  return language && BRACE_LANGUAGES.has(language) ? 'brace' : 'blank';
}

function findBoundary(
  lines: string[],
  startIndex: number,
  targetIndex: number,
  tolerance: number,
  family: TChunkFamily
): number {
  const boundaryFloor = Math.max(startIndex + 1, targetIndex - tolerance);
  const lineFloor = Math.max(startIndex, boundaryFloor - 1);

  for (let index = targetIndex - 1; index >= lineFloor; index -= 1) {
    const line = lines[index] ?? '';

    if (index >= boundaryFloor && line.trim() === '') {
      return index;
    }

    if (family === 'brace' && /^\s{0,2}[})\];]+\s*$/.test(line) && line.trim().length <= 3) {
      return index + 1;
    }

    if (
      family === 'indent' &&
      index >= boundaryFloor &&
      /^(?:(?:async\s+)?def|class)\b/.test(line) &&
      lines[index - 1]?.trim() === ''
    ) {
      return index;
    }
  }

  return targetIndex;
}
