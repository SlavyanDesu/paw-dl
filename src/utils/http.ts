export const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ConnectionClosed',
  'ConnectionRefused',
]);

export function parseRetryAfterToTimestamp(value: string | null): number {
  if (!value) {
    return 0;
  }

  const trimmed = value.trim();

  const timestamp = /^\d+$/.test(trimmed) ? Date.now() + Number(trimmed) * 1_000 : Date.parse(trimmed);

  if (Number.isNaN(timestamp)) {
    return 0;
  }

  if (!Number.isSafeInteger(timestamp)) {
    throw new RangeError('Retry-After value is too large.');
  }

  return timestamp;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
