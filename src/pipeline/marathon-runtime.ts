import { runAgent } from "../agents/runner.js";
import { withTimeout } from "../infra/timeout.js";

export async function runAgentWithAbort(
  options: Parameters<typeof runAgent>[0],
  signal: AbortSignal,
  timeoutMs: number,
  timeoutMessage: string,
  abortMessage: string,
) {
  return withAbort(withTimeout(runAgent(options), timeoutMs, timeoutMessage), signal, abortMessage);
}

export function throwIfAborted(signal: AbortSignal, message: string): void {
  if (signal.aborted) {
    throw new Error(message);
  }
}

export async function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  abortMessage: string,
): Promise<T> {
  if (signal.aborted) {
    throw new Error(abortMessage);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new Error(abortMessage));
    };

    signal.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /aborted|cancelled/i.test(msg);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
