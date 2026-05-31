import { NoObjectGeneratedError, APICallError } from "ai";

// Delays for 429 rate limit retries (per retry attempt index starting at 0)
export const RATE_LIMIT_DELAYS_MS = [5_000, 10_000, 20_000];

// Max retries per PR within a single pipeline run (across all error types)
export const MAX_LLM_RUN_RETRIES = 2;
const MAX_NO_OBJECT_ATTEMPTS = 2;
const MAX_SERVER_ERROR_ATTEMPTS = 2;

export function isRateLimitError(err: unknown): boolean {
  return err instanceof APICallError && err.statusCode === 429;
}

export function isServerError(err: unknown): boolean {
  return (
    err instanceof APICallError && err.statusCode !== undefined && err.statusCode >= 500
  );
}

export async function withLLMRetry<T>(
  callFn: () => Promise<T>,
  maxRunRetries: number = MAX_LLM_RUN_RETRIES
): Promise<T> {
  let runRetries = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await callFn();
    } catch (err) {
      if (err instanceof NoObjectGeneratedError) {
        const maxRetries = Math.min(maxRunRetries, MAX_NO_OBJECT_ATTEMPTS - 1);
        if (runRetries < maxRetries) {
          runRetries++;
          continue;
        }
        throw new Error(
          `LLM schema validation failed after ${runRetries + 1} attempt(s): ${err.message}`
        );
      }

      if (isRateLimitError(err)) {
        if (runRetries < maxRunRetries) {
          const delay = RATE_LIMIT_DELAYS_MS[runRetries] ?? 20_000;
          console.warn(
            `[LLM] Rate limited (429), retry ${runRetries + 1}/${maxRunRetries} in ${delay}ms`
          );
          await new Promise((r) => setTimeout(r, delay));
          runRetries++;
          continue;
        }
        throw err;
      }

      if (isServerError(err)) {
        const maxRetries = Math.min(maxRunRetries, MAX_SERVER_ERROR_ATTEMPTS - 1);
        if (runRetries < maxRetries) {
          const delay = Math.min(1_000 * Math.pow(2, runRetries), 30_000);
          console.warn(
            `[LLM] Server error (${(err as APICallError).statusCode}), retry ${runRetries + 1}/${maxRetries} in ${delay}ms`
          );
          await new Promise((r) => setTimeout(r, delay));
          runRetries++;
          continue;
        }
        throw err;
      }

      // Timeout and all other errors: propagate immediately
      throw err;
    }
  }
}
