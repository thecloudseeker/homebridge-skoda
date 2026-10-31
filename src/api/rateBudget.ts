/**
 * Request budget for one vehicle.
 *
 * The MyŠkoda Public API allows 20 requests per hour per VIN (not final; the `RateLimit-*` headers
 * are authoritative). Every request counts, including 5xx responses and commands; 401, 403 and 429
 * responses do not.
 *
 * The budget keeps its own sliding window of sent requests and additionally trusts what the server
 * reports. It always uses the stricter of both. Regular polls must leave `reserve` slots free so
 * commands and their follow-up refresh still go through.
 */

export const DEFAULT_RATE_LIMIT = 20;
export const DEFAULT_COMMAND_RESERVE = 4;
export const RATE_WINDOW_MS = 60 * 60 * 1000;

/** `poll` must respect the command reserve; `command` and `refresh` may use it. */
export type RequestKind = 'poll' | 'refresh' | 'command';

export interface RateLimitHeaders {
  limit?: number;
  remaining?: number;
  resetSeconds?: number;
}

export interface RateBudgetOptions {
  limit?: number;
  reserve?: number;
  windowMs?: number;
  now?: () => number;
}

/** Shortest polling interval (minutes) that keeps `reserve` slots free within one window. */
export function minimumPollingIntervalMinutes(
  limit = DEFAULT_RATE_LIMIT,
  reserve = DEFAULT_COMMAND_RESERVE,
): number {
  const pollsPerHour = Math.max(1, limit - reserve);
  return Math.ceil(60 / pollsPerHour);
}

export class RateBudget {
  private readonly reserve: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private limit: number;
  private sent: number[] = [];
  private server: { remaining: number; resetAt: number } | undefined;
  private blockedUntil = 0;

  constructor(options: RateBudgetOptions = {}) {
    this.limit = options.limit ?? DEFAULT_RATE_LIMIT;
    this.reserve = options.reserve ?? DEFAULT_COMMAND_RESERVE;
    this.windowMs = options.windowMs ?? RATE_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  get currentLimit(): number {
    return this.limit;
  }

  /** Requests left in the current window, the stricter of local bookkeeping and server headers. */
  remaining(): number {
    const now = this.now();
    if (now < this.blockedUntil) {
      return 0;
    }
    this.prune(now);
    let remaining = this.limit - this.sent.length;
    if (this.server && now < this.server.resetAt) {
      remaining = Math.min(remaining, this.server.remaining);
    }
    return Math.max(0, remaining);
  }

  canSpend(kind: RequestKind): boolean {
    return this.remaining() > (kind === 'poll' ? this.reserve : 0);
  }

  /** Records a request that is about to be sent. */
  record(): void {
    const now = this.now();
    this.sent.push(now);
    if (this.server && now < this.server.resetAt) {
      this.server.remaining = Math.max(0, this.server.remaining - 1);
    }
  }

  /** Gives back the most recent slot, for responses that do not count (401, 403, 429). */
  refund(): void {
    this.sent.pop();
  }

  updateFromHeaders(headers: RateLimitHeaders): void {
    if (headers.limit !== undefined && headers.limit > 0) {
      this.limit = headers.limit;
    }
    if (headers.remaining !== undefined) {
      const resetMs = (headers.resetSeconds ?? this.windowMs / 1000) * 1000;
      this.server = { remaining: Math.max(0, headers.remaining), resetAt: this.now() + resetMs };
    }
  }

  /** Blocks all requests until the given time, e.g. after a 429 with `Retry-After`. */
  blockUntil(timestamp: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, timestamp);
  }

  /** Earliest time at which a request of the given kind fits into the budget. */
  nextAvailableAt(kind: RequestKind): number {
    const now = this.now();
    if (this.canSpend(kind)) {
      return now;
    }
    const needed = kind === 'poll' ? this.reserve + 1 : 1;
    const candidates: number[] = [this.blockedUntil];

    // Local window: the oldest requests drop out one by one.
    this.prune(now);
    const excess = this.sent.length - (this.limit - needed);
    if (excess > 0) {
      const releasing = this.sent[excess - 1];
      if (releasing !== undefined) {
        candidates.push(releasing + this.windowMs);
      }
    }
    // Server window: the quota replenishes at the reset time.
    if (this.server && now < this.server.resetAt && this.server.remaining < needed) {
      candidates.push(this.server.resetAt);
    }
    return Math.max(now, ...candidates);
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.sent.length > 0 && (this.sent[0] ?? 0) <= cutoff) {
      this.sent.shift();
    }
  }
}
