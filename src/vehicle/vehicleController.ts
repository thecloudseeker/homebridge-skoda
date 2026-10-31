import type { SkodaApiClient } from '../api/client.js';
import { BudgetExhaustedError, SkodaApiError, SkodaNetworkError } from '../api/errors.js';
import type { Vehicle } from '../api/types.js';
import type { Logger } from '../util/logger.js';
import { mergeSnapshot, type VehicleSnapshot } from './snapshot.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MAX_BACKOFF_MS = 30 * MINUTE;
/** 401/403/404 do not fix themselves; 401 and 403 cost no quota, so retrying hourly is free. */
const CONFIG_ERROR_RETRY_MS = HOUR;
/** Data counts as stale after this many missed polling intervals. */
const STALE_AFTER_INTERVALS = 3;
const KEY_EXPIRY_WARNING_MS = 7 * 24 * HOUR;
const KEY_EXPIRY_WARNING_REPEAT_MS = 24 * HOUR;

export interface VehicleControllerOptions {
  pollClient: SkodaApiClient;
  /** May be the same client as `pollClient` when no separate command key is configured. */
  commandClient: SkodaApiClient;
  log: Logger;
  pollingIntervalMinutes: number;
  commandRefreshDelaySeconds: number;
}

type Listener = (snapshot: VehicleSnapshot | undefined) => void;

/**
 * Owns the cached state of one vehicle. HomeKit only ever reads from this cache; the controller
 * alone decides when to talk to the API, so the rate budget is never exceeded.
 */
export class VehicleController {
  private current: VehicleSnapshot | undefined;
  private readonly listeners = new Set<Listener>();
  private readonly intervalMs: number;
  private readonly refreshDelayMs: number;
  private pollTimer: NodeJS.Timeout | undefined;
  private staleTimer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private failures = 0;
  private lastErrorKey: string | undefined;
  private readonly keyExpiryWarnedAt = new Map<string, number>();
  private stopped = true;

  constructor(private readonly options: VehicleControllerOptions) {
    this.intervalMs = options.pollingIntervalMinutes * MINUTE;
    this.refreshDelayMs = options.commandRefreshDelaySeconds * 1000;
  }

  get snapshot(): VehicleSnapshot | undefined {
    return this.current;
  }

  /** True until the first successful poll, and when the last one is older than three intervals. */
  isStale(now = Date.now()): boolean {
    return !this.current || now - this.current.fetchedAt > STALE_AFTER_INTERVALS * this.intervalMs;
  }

  onUpdate(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    this.stopped = false;
    this.schedule(0, 'poll');
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    clearTimeout(this.staleTimer);
  }

  /**
   * Sends a command and schedules one follow-up refresh. On success the optional `optimistic`
   * patch is applied to the cache right away, so HomeKit shows the expected state until the
   * refresh confirms it. Errors are logged and rethrown for the caller to revert the UI.
   */
  async runCommand(
    label: string,
    send: (client: SkodaApiClient) => Promise<void>,
    optimistic?: (vehicle: Vehicle) => void,
  ): Promise<void> {
    try {
      await send(this.options.commandClient);
    } catch (error) {
      this.options.log.warn(`${label} failed: ${describeCommandError(error)}`);
      throw error;
    }
    this.options.log.info(`${label}: accepted by the vehicle`);
    if (optimistic && this.current) {
      const patched = structuredClone(this.current);
      optimistic(patched.vehicle);
      this.current = patched;
      this.emit();
    }
    this.schedule(this.refreshDelayMs, 'refresh');
  }

  /** Warns ahead of the expiry announced in `X-API-Key-Expires-At`, at most once a day per key. */
  noteKeyExpiry(keyLabel: string, expiresAt: Date, now = Date.now()): void {
    const remainingMs = expiresAt.getTime() - now;
    if (remainingMs > KEY_EXPIRY_WARNING_MS) {
      return;
    }
    const lastWarned = this.keyExpiryWarnedAt.get(keyLabel);
    if (lastWarned !== undefined && now - lastWarned < KEY_EXPIRY_WARNING_REPEAT_MS) {
      return;
    }
    this.keyExpiryWarnedAt.set(keyLabel, now);
    const days = Math.max(0, Math.floor(remainingMs / (24 * HOUR)));
    this.options.log.warn(
      `The ${keyLabel} expires on ${expiresAt.toISOString()} (in ${days} day(s)). ` +
        'Renew it in the MyŠkoda app under Profile > Smart Home (https://go.skoda.eu/api-keys).',
    );
  }

  private schedule(delayMs: number, kind: 'poll' | 'refresh'): void {
    if (this.stopped) {
      return;
    }
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      void this.poll(kind);
    }, Math.max(0, delayMs));
    this.pollTimer.unref();
  }

  private poll(kind: 'poll' | 'refresh'): Promise<void> {
    // A command may schedule a refresh while a poll is running; the running poll is enough.
    this.inFlight ??= this.fetch(kind).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async fetch(kind: 'poll' | 'refresh'): Promise<void> {
    try {
      const response = await this.options.pollClient.getVehicle(kind);
      this.current = mergeSnapshot(this.current, response, Date.now());
      if (this.failures > 0 || this.lastErrorKey) {
        this.options.log.info('Connection to the MyŠkoda API restored');
      }
      this.failures = 0;
      this.lastErrorKey = undefined;
      this.options.log.debug(`Vehicle data updated (${response.errors?.length ?? 0} partial-data notice(s))`);
      this.schedule(this.intervalMs, 'poll');
    } catch (error) {
      this.handlePollError(error, kind);
    }
    this.armStaleTimer();
    this.emit();
  }

  private handlePollError(error: unknown, kind: 'poll' | 'refresh'): void {
    const { log } = this.options;
    const now = Date.now();

    if (error instanceof BudgetExhaustedError) {
      log.debug(`Request budget exhausted, next ${kind} at ${new Date(error.availableAt).toISOString()}`);
      this.schedule(error.availableAt - now + 1000, kind);
      return;
    }

    this.failures++;

    if (error instanceof SkodaApiError) {
      if (error.isAuthError || error.status === 404) {
        this.logOnce(`${error.status}:${error.problemType ?? ''}`, () => {
          log.error(`${describeConfigError(error)} Retrying every hour.`);
        });
        this.schedule(CONFIG_ERROR_RETRY_MS, 'poll');
        return;
      }
      if (error.status === 429 || error.status === 503) {
        const retryMs = (error.retryAfterSeconds ?? 0) * 1000;
        log.warn(`Vehicle update deferred (${error.message}); retrying in ${formatDelay(Math.max(retryMs, this.backoffMs()))}`);
        this.schedule(Math.max(retryMs, this.backoffMs()), 'poll');
        return;
      }
      if (error.status === 400) {
        log.error(`The API rejected the request as invalid (${error.message}). Please report this as a bug.`);
      } else {
        log.warn(`Vehicle update failed (${error.message}); retrying in ${formatDelay(this.backoffMs())}`);
      }
    } else if (error instanceof SkodaNetworkError) {
      log.warn(`Vehicle update failed: ${error.message}; retrying in ${formatDelay(this.backoffMs())}`);
    } else {
      log.error(`Unexpected error while updating the vehicle: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.schedule(this.backoffMs(), 'poll');
  }

  /** Exponential backoff starting at the polling interval, capped at 30 minutes (or the interval if longer). */
  private backoffMs(): number {
    const exponential = this.intervalMs * 2 ** Math.max(0, this.failures - 1);
    return Math.max(this.intervalMs, Math.min(exponential, MAX_BACKOFF_MS));
  }

  private logOnce(key: string, write: () => void): void {
    if (this.lastErrorKey !== key) {
      this.lastErrorKey = key;
      write();
    }
  }

  /** Emits once more when the data turns stale, so StatusFault flips even without a poll. */
  private armStaleTimer(): void {
    clearTimeout(this.staleTimer);
    if (this.stopped || !this.current || this.isStale()) {
      return;
    }
    const staleAt = this.current.fetchedAt + STALE_AFTER_INTERVALS * this.intervalMs + 1;
    this.staleTimer = setTimeout(() => {
      this.emit();
    }, staleAt - Date.now());
    this.staleTimer.unref();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.current);
      } catch (error) {
        this.options.log.error(`Failed to update HomeKit: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

function describeConfigError(error: SkodaApiError): string {
  switch (error.problemType) {
    case 'api-key-expired':
      return 'The API key has expired. Create or update a key in the MyŠkoda app and update the plugin config.';
    case 'api-key-not-authorized':
      return 'The API key does not cover this vehicle or operation. Check the key and the VIN in the plugin config.';
    case 'operation-not-authorized':
      return 'The vehicle refused the request for the user the API key belongs to.';
  }
  return error.status === 404 ? 'No vehicle found for the configured VIN.' : `Access denied (${error.message}).`;
}

export function describeCommandError(error: unknown): string {
  if (error instanceof BudgetExhaustedError) {
    return `rate limit budget exhausted until ${new Date(error.availableAt).toLocaleTimeString()}`;
  }
  if (error instanceof SkodaApiError) {
    switch (error.problemType) {
      case 'operation-not-supported':
        return 'the vehicle does not support this operation';
      case 'operation-disabled':
        return 'this function is currently disabled for the vehicle';
      case 'vehicle-not-accepting-requests':
        return 'the vehicle declined the request, try again later';
      case 'rate-limit-exceeded':
        return 'rate limit exceeded';
      case 'api-key-expired':
      case 'api-key-not-authorized':
      case 'operation-not-authorized':
        return describeConfigError(error);
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function formatDelay(ms: number): string {
  return ms >= MINUTE ? `${Math.round(ms / MINUTE)} min` : `${Math.round(ms / 1000)} s`;
}
