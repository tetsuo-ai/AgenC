/**
 * Timeout helper for LLM provider calls.
 *
 * @module
 */

function createAbortTimeoutError(providerName: string, timeoutMs: number): Error {
  const err = new Error(`${providerName} request aborted after ${timeoutMs}ms`);
  (err as any).name = 'AbortError';
  (err as any).code = 'ABORT_ERR';
  return err;
}

/**
 * Execute an async provider call with an explicit AbortController timeout.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | undefined,
  providerName: string,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    const controller = new AbortController();
    return fn(controller.signal);
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(createAbortTimeoutError(providerName, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
