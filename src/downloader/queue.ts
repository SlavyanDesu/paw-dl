import pLimit from 'p-limit';

export type Task<T> = () => Promise<T>;

export function createQueue(concurrency = 3) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('Concurrency must be a number.');
  }

  const limit = pLimit(concurrency);

  async function run<T>(tasks: readonly Task<T>[]): Promise<PromiseSettledResult<T>[]> {
    const pending = tasks.map((task) => limit(task));

    return Promise.allSettled(pending);
  }

  return {
    run,

    get activeCount(): number {
      return limit.activeCount;
    },

    get pendingCount(): number {
      return limit.pendingCount;
    },
  };
}
