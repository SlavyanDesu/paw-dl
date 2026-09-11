import { extname } from 'node:path';
import sanitize from 'sanitize-filename';

const MAX_COMPONENT_LENGTH = 60;

export function sanitizeName(value: string): string {
  const normalized = value.normalize('NFC').replace(/\s+/g, ' ').trim();

  const shortened = Array.from(normalized).slice(0, MAX_COMPONENT_LENGTH).join('');

  return sanitize(shortened, { replacement: '_' }) || 'untitled';
}

export function formatPostDate(published: string | null): string {
  const match = published?.match(/^(\d{4})-(\d{2})-(\d{2})(?:T| |$)/);

  if (!match) {
    throw new Error('The published date is unavailable or invalid.');
  }

  const [, year, month, day] = match;

  if (!year || !month || !day) {
    throw new Error('The published date is incomplete.');
  }

  const isoDate = `${year}-${month}-${day}`;
  const date = new Date(`${isoDate}T00:00:00Z`);

  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== isoDate) {
    throw new Error(`The published date is invalid: ${isoDate}`);
  }

  return `${year}${month}${day}`;
}

export function createPostNames(
  user: string,
  title: string,
  published: string | null,
): { folderName: string; fileStem: string } {
  const fileStem = `${sanitizeName(user)}-${sanitizeName(title)}`;
  const date = formatPostDate(published);

  return {
    folderName: `[${date}] ${fileStem}`,
    fileStem,
  };
}

function extractRawExtension(originalName: string, filePath: string): string | null {
  for (const source of [originalName, filePath]) {
    const cleanSource = source.split(/[?#]/)[0] ?? '';

    const extension = extname(cleanSource);

    if (/^\.[a-zA-Z0-9]{1,10}$/.test(extension)) {
      return extension;
    }
  }

  return null;
}

export function getAttachmentExtension(originalName: string, filePath: string): string {
  const extension = extractRawExtension(originalName, filePath);

  if (!extension) {
    return '';
  }

  const lowered = extension.slice(1).toLowerCase();

  return /^[a-z0-9]{1,10}$/.test(lowered) ? lowered : '';
}

function getExtension(originalName: string, filePath: string): string {
  return extractRawExtension(originalName, filePath) ?? '.bin';
}

export function createFileName(fileStem: string, originalName: string, filePath: string, order: number): string {
  if (!Number.isSafeInteger(order) || order < 1) {
    throw new Error('File order must be a positive integer.');
  }

  const sequence = String(order).padStart(3, '0');
  const extension = getExtension(originalName, filePath);

  return `${fileStem}-${sequence}${extension}`;
}
