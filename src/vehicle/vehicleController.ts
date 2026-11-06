import type { SkodaApiClient } from "../api/client.js";
import {
  BudgetExhaustedError,
  SkodaApiError,
  SkodaNetworkError,
} from "../api/errors.js";
import type { OperationName } from "../api/types.js";
import type { Logger } from "../util/logger.js";
import { ExpectedState, type OptimisticPatch } from "./expectedState.js";
import { describeReport } from "./mapping.js";
import {
  describeCommandError,
  describeConfigError,
  formatDelay,
} from "./messages.js";
import { mergeSnapshot, type VehicleSnapshot } from "./snapshot.js";

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
  client: SkodaApiClient;
  log: Logger;
  pollingIntervalMinutes: number;
}

export interface CommandOptions {
  /** Operations the command uses; `operation-not-supported` marks them as unsupported. */
  operations?: readonly OperationName[];
  /** Expected state, shown until the vehicle reports the part again. */
  optimistic?: OptimisticPatch;
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
  private pollTimer: NodeJS.Timeout | undefined;
  private staleTimer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private failures = 0;
  private lastErrorKey: string | undefined;
  private keyExpiryWarnedAt: number | undefined;
  private readonly expected = new ExpectedState();
  private stopped = true;
  private readonly shutdown = new AbortController();

  constructor(private readonly options: VehicleControllerOptions) {
    this.intervalMs = options.pollingIntervalMinutes * MINUTE;
  }

  get snapshot(): VehicleSnapshot | undefined {
    return this.current;
  }

  /** True until the first successful poll, and when the last one is older than three intervals. */
  isStale(now = Date.now()): boolean {
    return (
      !this.current ||
      now - this.current.fetchedAt > STALE_AFTER_INTERVALS * this.intervalMs
    );
  }

  /** Aborted when Homebridge shuts down, so commands that are still waiting are dropped. */
  get signal(): AbortSignal {
    return this.shutdown.signal;
  }

  onUpdate(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  /** Stops polling and drops waiting commands; called when Homebridge shuts down. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    clearTimeout(this.staleTimer);
    this.shutdown.abort();
  }

  /**
   * Sends a command. On success the optional optimistic patch is applied to the cache right away
   * and re-applied after every poll until the vehicle reports the changed part again, because the
   * vehicle reports new state with a delay, so no extra request is spent on confirming it. Errors
   * are logged and rethrown for the caller to revert the UI.
   */
  async runCommand(
    label: string,
    send: (client: SkodaApiClient) => Promise<void>,
    options: CommandOptions = {},
  ): Promise<void> {
    const { operations = [], optimistic } = options;
    try {
      await send(this.options.client);
    } catch (error) {
      this.options.log.warn(`${label} failed: ${describeCommandError(error)}`);
      if (
        error instanceof SkodaApiError &&
        error.problemType === "operation-not-supported" &&
        operations.length > 0
      ) {
        this.rejectOperations(operations);
      }
      throw error;
    }
    this.options.log.info(`${label}: accepted by the vehicle`);
    if (optimistic) {
      const patched = this.expected.add(optimistic, this.current);
      if (patched) {
        this.current = patched;
        this.emit();
      }
    }
  }

  /** Warns ahead of the expiry announced in `X-API-Key-Expires-At`, at most once a day. */
  noteKeyExpiry(expiresAt: Date, now = Date.now()): void {
    const remainingMs = expiresAt.getTime() - now;
    if (remainingMs > KEY_EXPIRY_WARNING_MS) {
      return;
    }
    if (
      this.keyExpiryWarnedAt !== undefined &&
      now - this.keyExpiryWarnedAt < KEY_EXPIRY_WARNING_REPEAT_MS
    ) {
      return;
    }
    this.keyExpiryWarnedAt = now;
    const days = Math.max(0, Math.floor(remainingMs / (24 * HOUR)));
    this.options.log.warn(
      `The API key expires on ${expiresAt.toISOString()} (in ${days} day(s)). ` +
        "Renew it in the MyŠkoda app under Profile > Smart Home (https://go.skoda.eu/api-keys).",
    );
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(
      () => {
        void this.poll();
      },
      Math.max(0, delayMs),
    );
    this.pollTimer.unref();
  }

  private poll(): Promise<void> {
    this.inFlight ??= this.fetch().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async fetch(): Promise<void> {
    try {
      const response = await this.options.client.getVehicle();
      // Before merging, so the line shows what the vehicle reported, not the expected state.
      const reported = describeReport(response.vehicle);
      this.current = this.expected.apply(
        mergeSnapshot(this.current, response, Date.now()),
      );
      if (this.failures > 0 || this.lastErrorKey) {
        this.options.log.info("Connection to the MyŠkoda API restored");
      }
      this.failures = 0;
      this.lastErrorKey = undefined;
      const notices = (response.errors ?? []).map((error) => error.type);
      this.options.log.debug(
        `Vehicle data updated (notices: ${notices.join(", ") || "none"})`,
      );
      this.options.log.debug(`Reported: ${reported}`);
      this.schedule(this.intervalMs);
    } catch (error) {
      this.handlePollError(error);
    }
    this.armStaleTimer();
    this.emit();
  }

  private handlePollError(error: unknown): void {
    const { log } = this.options;
    const now = Date.now();

    if (error instanceof BudgetExhaustedError) {
      log.debug(
        `Request budget exhausted, next update at ${new Date(error.availableAt).toISOString()}`,
      );
      this.schedule(error.availableAt - now + 1000);
      return;
    }

    this.failures++;

    if (error instanceof SkodaApiError) {
      if (error.isAuthError || error.status === 404) {
        this.logOnce(`${error.status}:${error.problemType ?? ""}`, () => {
          log.error(`${describeConfigError(error)} Retrying every hour.`);
        });
        this.schedule(CONFIG_ERROR_RETRY_MS);
        return;
      }
      if (error.status === 429 || error.status === 503) {
        const retryMs = (error.retryAfterSeconds ?? 0) * 1000;
        log.warn(
          `Vehicle update deferred (${error.message}); retrying in ${formatDelay(Math.max(retryMs, this.backoffMs()))}`,
        );
        this.schedule(Math.max(retryMs, this.backoffMs()));
        return;
      }
      if (error.status === 400) {
        log.error(
          `The API rejected the request as invalid (${error.message}). Please report this as a bug.`,
        );
      } else {
        log.warn(
          `Vehicle update failed (${error.message}); retrying in ${formatDelay(this.backoffMs())}`,
        );
      }
    } else if (error instanceof SkodaNetworkError) {
      log.warn(
        `Vehicle update failed: ${error.message}; retrying in ${formatDelay(this.backoffMs())}`,
      );
    } else {
      log.error(
        `Unexpected error while updating the vehicle: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.schedule(this.backoffMs());
  }

  /** The vehicle lacks the capability, so its control is removed until restart. */
  private rejectOperations(operations: readonly OperationName[]): void {
    this.expected.reject(operations);
    this.options.log.warn(
      `The vehicle does not support ${operations.join(", ")}; the control will be removed`,
    );
    if (this.current) {
      this.current = this.expected.withoutRejected(this.current);
      this.emit();
    }
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
    const staleAt =
      this.current.fetchedAt + STALE_AFTER_INTERVALS * this.intervalMs + 1;
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
        this.options.log.error(
          `Failed to update HomeKit: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
