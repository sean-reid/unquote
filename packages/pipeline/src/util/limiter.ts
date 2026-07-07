export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Bound the number of concurrent tasks. Keeps us fast but polite: a handful of
 * simultaneous requests per host rather than a serial stream or an unbounded flood.
 */
export function createLimiter(max: number): Limiter {
  let active = 0;
  const queue: (() => void)[] = [];

  const acquire = (): Promise<void> => {
    if (active < max) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) =>
      queue.push(() => {
        active += 1;
        resolve();
      }),
    );
  };

  const release = (): void => {
    active -= 1;
    queue.shift()?.();
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}

const perHost = new Map<string, Limiter>();

/** Get (or create) a shared limiter for a host. */
export function hostLimiter(host: string, max: number): Limiter {
  let limiter = perHost.get(host);
  if (!limiter) {
    limiter = createLimiter(max);
    perHost.set(host, limiter);
  }
  return limiter;
}
