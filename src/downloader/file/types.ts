export const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
// ponytail: global cap, per-server limits if legit large files appear
export const MAX_FILE_BYTES = 10 * 1024 * 1024 * 1024;

export type FileManifestEntry = {
  filename: string;
  source: string;
  size: number;
  etag: string | null;
};

export type DownloadResult = {
  status: 'saved' | 'skipped';
  destination: string;
  manifest: FileManifestEntry;
};

export type DownloadFileOptions = {
  expected?: FileManifestEntry;
};

export type ResumeMetadata = {
  version: 1;
  source: string;
  etag: string | null;
  total: number | null;
};

export type ResumeContext = {
  canResume: boolean;
  metadata: ResumeMetadata | null;
  savedETag: string | null;
  offset: number;
};

export type DownloadPlan = {
  status: 200 | 206;
  etag: string | null;
  startOffset: number;
  total: number | null;
  responseEnd: number | null;
};

export type ResponseOutcome =
  | { kind: 'abort'; message: string }
  | { kind: 'retryFull'; message: string }
  | { kind: 'retryWithBackoff'; message: string; retryAt: number }
  | ({ kind: 'download' } & DownloadPlan);
