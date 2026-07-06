export type TContextKind =
  | 'file'
  | 'log'
  | 'diff'
  | 'markdown'
  | 'error'
  | 'stacktrace'
  | 'json'
  | 'sql'
  | 'http';

export interface IContextConfig {
  database: string;
  chunkSize: number;
  searchLimit: number;
  watch: boolean;
  ignore: string[];
}

export interface IProject {
  id: number;
  name: string;
  root: string;
  createdAt: string;
  updatedAt: string;
}

export interface IChunk {
  id: number;
  projectId: number | null;
  path: string;
  scope: string;
  kind: TContextKind;
  language: string;
  startLine: number;
  endLine: number;
  hash: string;
  content: string;
  createdAt: string;
}

export interface IChunkInput {
  projectId: number | null;
  path: string;
  scope: string;
  kind: TContextKind;
  language: string;
  startLine: number;
  endLine: number;
  hash: string;
  content: string;
}

export interface IContentChunk {
  startLine: number;
  endLine: number;
  content: string;
  hash: string;
}

export interface ISearchResult {
  id: number;
  projectId: number | null;
  path: string;
  scope: string;
  kind: TContextKind;
  language: string;
  startLine: number;
  endLine: number;
  hash: string;
  snippet: string;
  rank: number;
}

export interface IStats {
  projects: number;
  files: number;
  chunks: number;
  databaseBytes: number;
}

export interface IIngestSummary {
  indexed: number;
  skipped: number;
  ignored: number;
  failed: number;
  chunks: number;
  errors: string[];
}
