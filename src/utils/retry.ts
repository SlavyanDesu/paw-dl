import pRetry from 'p-retry';

export const MAX_RETRY_WAIT_SLEEP_MS = 60_000;

export class RetryableError extends Error {
  retryAt = 0;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RetryableError';
  }
}

type RetryOptions = {
  retries?: number;
  factor?: number;
  minTimeout?: number;
  maxTimeout?: number;
  onFailedAttempt?: (error: Error, attemptNumber: number) => void;
};

/*
 * Shared backoff: retryable errors honor Retry-After timestamps,
 * everything else fails fast. Used by API client and file download.
 */
export async function retryWithBackoff<T>(
  task: (attemptNumber: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { retries = 3, factor = 2, minTimeout = 1_000, maxTimeout = 10_000, onFailedAttempt } = options;

  return pRetry(task, {
    retries,
    factor,
    minTimeout,
    maxTimeout,
    randomize: true,

    onFailedAttempt: ({ error, attemptNumber }) => {
      onFailedAttempt?.(error as Error, attemptNumber);
    },

    shouldRetry: async ({ error }) => {
      if (!(error instanceof RetryableError)) {
        return false;
      }

      while (Date.now() < error.retryAt) {
        await Bun.sleep(Math.min(error.retryAt - Date.now(), MAX_RETRY_WAIT_SLEEP_MS));
      }

      return true;
    },
  });
}
