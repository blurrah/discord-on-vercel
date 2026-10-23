const debug = process.env.GATEWAY_DEBUG === '1' || process.env.GATEWAY_DEBUG === 'true';

/** stdout/stderr go straight to the project's Logs on Vercel (source: daemon). */
export const log = {
  debug: (message: string) => debug && console.log(`[gateway] ${message}`),
  info: (message: string) => console.log(`[gateway] ${message}`),
  warn: (message: string) => console.warn(`[gateway] ${message}`),
  error: (message: string, error?: unknown) =>
    error === undefined ? console.error(`[gateway] ${message}`) : console.error(`[gateway] ${message}`, error),
};

/** `fetch failed: connect ECONNREFUSED …` instead of a multi-line stack trace. */
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (!(error.cause instanceof Error)) return error.message;
  const cause = error.cause as Error & { code?: string };
  return `${error.message}: ${cause.message || cause.code || cause.name}`;
}
