import type { Attachment } from '../api/schemas.ts';
import { FILE_ORIGIN } from './http.ts';

export function createFileUrl(file: Attachment): URL {
  if (!file.path.startsWith('/') || file.path.startsWith('//') || /[\\?#]/.test(file.path)) {
    throw new Error(`Invalid attachment path: ${file.path}`);
  }

  const url = new URL(`/data${file.path}`, FILE_ORIGIN);

  if (url.origin !== FILE_ORIGIN || !url.pathname.startsWith('/data/')) {
    throw new Error('Attachment URL escapes file location.');
  }

  if (file.name) {
    url.searchParams.set('f', file.name);
  }

  return url;
}

export function sourceIdentity(url: URL): string {
  // The ?f= parameter changes the download name, not which file we're fetching.
  return `${url.origin}${url.pathname}`;
}
