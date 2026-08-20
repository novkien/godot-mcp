export interface BridgeRetryOptions {
  timeoutMs: number;
  retryDelayMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface BridgeRetryResult {
  connected: boolean;
  attempts: number;
  elapsedMs: number;
  lastError: string | null;
  stopped: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Retry a runtime bridge connection until it succeeds, the caller-provided
 * lifecycle predicate becomes false, or the bounded deadline is exhausted.
 *
 * The injected clock/sleep hooks keep the policy deterministic in unit tests
 * without waiting in real time.
 */
export async function retryBridgeConnection(
  attemptConnection: (attempt: number) => Promise<void>,
  shouldContinue: () => boolean,
  options: BridgeRetryOptions,
): Promise<BridgeRetryResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive finite number');
  }
  if (!Number.isFinite(options.retryDelayMs) || options.retryDelayMs < 0) {
    throw new Error('retryDelayMs must be a non-negative finite number');
  }

  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const startedAt = now();
  let attempts = 0;
  let lastError: string | null = null;

  while (shouldContinue()) {
    const elapsedBeforeAttempt = now() - startedAt;
    if (elapsedBeforeAttempt > options.timeoutMs) break;

    attempts += 1;
    try {
      await attemptConnection(attempts);
      return {
        connected: true,
        attempts,
        elapsedMs: Math.max(0, now() - startedAt),
        lastError: null,
        stopped: false,
      };
    } catch (error) {
      lastError = errorMessage(error);
    }

    if (!shouldContinue()) break;

    const elapsedAfterAttempt = now() - startedAt;
    const remainingMs = options.timeoutMs - elapsedAfterAttempt;
    if (remainingMs <= 0) break;

    const delayMs = Math.min(options.retryDelayMs, remainingMs);
    if (delayMs > 0) await sleep(delayMs);
  }

  return {
    connected: false,
    attempts,
    elapsedMs: Math.max(0, now() - startedAt),
    lastError,
    stopped: !shouldContinue(),
  };
}
