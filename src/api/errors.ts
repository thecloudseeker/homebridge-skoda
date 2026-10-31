import type { ProblemDetail } from './types.js';

/** Problem types documented at https://public.api.connect.skoda-auto.cz/docs#errors. */
export type ProblemType =
  | 'api-key-expired'
  | 'api-key-not-authorized'
  | 'operation-not-authorized'
  | 'operation-not-supported'
  | 'operation-disabled'
  | 'rate-limit-exceeded'
  | 'vehicle-not-accepting-requests'
  | (string & {});

const PROBLEM_TYPE_PREFIX = '/problems/';

/** Extracts the short problem type from a problem type URI; `about:blank` and unknown URIs yield undefined. */
export function parseProblemType(type: string | undefined): ProblemType | undefined {
  if (!type || type === 'about:blank') {
    return undefined;
  }
  const index = type.lastIndexOf(PROBLEM_TYPE_PREFIX);
  return index === -1 ? undefined : type.slice(index + PROBLEM_TYPE_PREFIX.length);
}

/** An HTTP error response from the API. Never carries the API key. */
export class SkodaApiError extends Error {
  override readonly name = 'SkodaApiError';

  constructor(
    readonly status: number,
    readonly problemType: ProblemType | undefined,
    readonly detail: string | undefined,
    /** Seconds to wait, from the `Retry-After` header. */
    readonly retryAfterSeconds: number | undefined,
    readonly problem?: ProblemDetail,
  ) {
    super(`HTTP ${status}${problemType ? ` ${problemType}` : ''}${detail ? `: ${detail}` : ''}`);
  }

  /** 401 and 403: the key is expired or does not cover the request. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }

  get isRateLimited(): boolean {
    return this.status === 429 && this.problemType !== 'vehicle-not-accepting-requests';
  }
}

/** The request never produced an HTTP response (DNS, connection reset, timeout). */
export class SkodaNetworkError extends Error {
  override readonly name = 'SkodaNetworkError';
}

/** The local request budget has no slot left; the request was not sent. */
export class BudgetExhaustedError extends Error {
  override readonly name = 'BudgetExhaustedError';

  constructor(readonly availableAt: number) {
    super(`Request budget exhausted until ${new Date(availableAt).toISOString()}`);
  }
}
