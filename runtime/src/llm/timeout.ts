/**
 * Timeout helper for LLM provider calls.
 *
 * @module
 */

function createAbortTimeoutError(
  providerName: string,
  timeoutMs: number,
): Error {
  const err = new Error(`${providerName} request aborted after ${timeoutMs}ms`);
  (err as any).name = "AbortError";
  (err as any).code = "ABORT_ERR";
  return err;
}

/**
 * Execute an async provider call with an explicit AbortController timeout.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | undefined,
  providerName: string,
  externalSignal?: AbortSignal,
): Promise<T> {
  if ((!timeoutMs || timeoutMs <= 0) && !externalSignal) {
    const controller = new AbortController();
    return fn(controller.signal);
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const guardPromises: Promise<never>[] = [];

  if (timeoutMs && timeoutMs > 0) {
    guardPromises.push(new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(createAbortTimeoutError(providerName, timeoutMs));
      }, timeoutMs);
    }));
  }

  if (externalSignal) {
    guardPromises.push(new Promise<never>((_, reject) => {
      abortHandler = () => {
        controller.abort();
        reject(createAbortTimeoutError(providerName, timeoutMs ?? 0));
      };
      if (externalSignal.aborted) {
        abortHandler();
        return;
      }
      externalSignal.addEventListener("abort", abortHandler, { once: true });
    }));
  }

  try {
    return await Promise.race([fn(controller.signal), ...guardPromises]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (externalSignal && abortHandler) {
      externalSignal.removeEventListener("abort", abortHandler);
    }
  }
}
