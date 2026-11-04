import type { SkodaApiClient } from "../api/client.js";
import {
  BudgetExhaustedError,
  SkodaApiError,
  SkodaNetworkError,
} from "../api/errors.js";
import type { OperationName, Vehicle } from "../api/types.js";
import type { Logger } from "../util/logger.js";
import { describeReport } from "./mapping.js";
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
/** An optimistic state is dropped after this long, even if the vehicle never reports back. */
const OPTIMISTIC_TTL_MS = 15 * MINUTE;

export interface VehicleControllerOptions {
  client: SkodaApiClient;
  log: Logger;
  pollingIntervalMinutes: number;
}

/** Parts that carry a `carCapturedTimestamp`, which tells when the vehicle last reported them. */
export type ReportedPart =
  "charging" | "airConditioning" | "auxiliaryHeating" | "activeVentilation";

export interface OptimisticPatch {
  /** The part the command changes. */
  part: ReportedPart;
  apply: (vehicle: Vehicle) => void;
}

export interface CommandOptions {
  /** Operations the command uses; `operation-not-supported` marks them as unsupported. */
  operations?: readonly OperationName[];
  /** Expected state, shown until the vehicle reports the part again. */
  optimistic?: OptimisticPatch;
}

interface PendingPatch extends OptimisticPatch {
  sentAt: number;
  /** `carCapturedTimestamp` of the part when the command was sent. */
  capturedBefore: string | undefined;
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
  private readonly keyExpiryWarnedAt = new Map<string, number>();
  private pending: PendingPatch[] = [];
  private readonly rejectedOperations = new Set<OperationName>();
  private stopped = true;

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

  onUpdate(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    clearTimeout(this.staleTimer);
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
      this.pending.push({
        ...optimistic,
        sentAt: Date.now(),
        capturedBefore: capturedAt(this.current?.vehicle, optimistic.part),
      });
      if (this.current) {
        const patched = structuredClone(this.current);
        optimistic.apply(patched.vehicle);
        this.current = patched;
        this.emit();
      }
    }
  }

  /** Warns ahead of the expiry announced in `X-API-Key-Expires-At`, at most once a day per key. */
  noteKeyExpiry(keyLabel: string, expiresAt: Date, now = Date.now()): void {
    const remainingMs = expiresAt.getTime() - now;
    if (remainingMs > KEY_EXPIRY_WARNING_MS) {
      return;
    }
    const lastWarned = this.keyExpiryWarnedAt.get(keyLabel);
    if (
      lastWarned !== undefined &&
      now - lastWarned < KEY_EXPIRY_WARNING_REPEAT_MS
    ) {
      return;
    }
    this.keyExpiryWarnedAt.set(keyLabel, now);
    const days = Math.max(0, Math.floor(remainingMs / (24 * HOUR)));
    this.options.log.warn(
      `The ${keyLabel} expires on ${expiresAt.toISOString()} (in ${days} day(s)). ` +
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
      this.current = this.applyLocalState(
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

  /**
   * Re-applies optimistic patches the vehicle has not confirmed yet, and hides operations the
   * vehicle rejected as unsupported.
   */
  private applyLocalState(snapshot: VehicleSnapshot): VehicleSnapshot {
    const now = snapshot.fetchedAt;
    this.pending = this.pending.filter(
      (patch) =>
        now - patch.sentAt < OPTIMISTIC_TTL_MS &&
        !reportedSince(snapshot.vehicle, patch),
    );
    if (this.pending.length === 0 && this.rejectedOperations.size === 0) {
      return snapshot;
    }
    const patched = structuredClone(snapshot);
    for (const patch of this.pending) {
      patch.apply(patched.vehicle);
    }
    this.removeRejectedOperations(patched.vehicle);
    return patched;
  }

  /** Remembered until restart: the vehicle lacks the capability, so retrying does not help. */
  private rejectOperations(operations: readonly OperationName[]): void {
    for (const name of operations) {
      this.rejectedOperations.add(name);
    }
    this.options.log.warn(
      `The vehicle does not support ${operations.join(", ")}; the control will be removed`,
    );
    if (this.current) {
      const patched = structuredClone(this.current);
      this.removeRejectedOperations(patched.vehicle);
      this.current = patched;
      this.emit();
    }
  }

  private removeRejectedOperations(vehicle: Vehicle): void {
    if (vehicle.operations && this.rejectedOperations.size > 0) {
      vehicle.operations = vehicle.operations.filter(
        (operation) => !this.rejectedOperations.has(operation.name),
      );
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

function capturedAt(
  vehicle: Vehicle | undefined,
  part: ReportedPart,
): string | undefined {
  return vehicle?.[part]?.carCapturedTimestamp;
}

/** The vehicle has reported the part since the command: a new timestamp, captured after sending. */
function reportedSince(vehicle: Vehicle, patch: PendingPatch): boolean {
  const captured = capturedAt(vehicle, patch.part);
  if (captured === undefined || captured === patch.capturedBefore) {
    return false;
  }
  const capturedMs = Date.parse(captured);
  return Number.isFinite(capturedMs) && capturedMs > patch.sentAt;
}

function describeConfigError(error: SkodaApiError): string {
  switch (error.problemType) {
    case "api-key-expired":
      return "The API key has expired. Create or update a key in the MyŠkoda app and update the plugin config.";
    case "api-key-not-authorized":
      return "The API key does not cover this vehicle or operation. Check the key and the VIN in the plugin config.";
    case "operation-not-authorized":
      return "The vehicle refused the request for the user the API key belongs to.";
  }
  switch (error.status) {
    case 401:
      // Observed for unknown or deleted keys: `about:blank` with "Missing or invalid API key."
      return "The API key is invalid or no longer exists. Check the key in the plugin config or create a new one in the MyŠkoda app.";
    case 404:
      return "No vehicle found for the configured VIN.";
  }
  return `Access denied (${error.message}).`;
}

export function describeCommandError(error: unknown): string {
  if (error instanceof BudgetExhaustedError) {
    return `rate limit budget exhausted until ${new Date(error.availableAt).toLocaleTimeString()}`;
  }
  if (error instanceof SkodaApiError) {
    switch (error.problemType) {
      case "operation-not-supported":
        return "the vehicle does not support this operation";
      case "operation-disabled":
        return "this function is currently disabled for the vehicle";
      case "vehicle-not-accepting-requests":
        return "the vehicle declined the request, e.g. because its 12 V battery is low; try again later";
      case "rate-limit-exceeded":
        return "rate limit exceeded";
      case "api-key-expired":
      case "api-key-not-authorized":
      case "operation-not-authorized":
        return describeConfigError(error);
    }
    return error.isAuthError || error.status === 404
      ? describeConfigError(error)
      : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function formatDelay(ms: number): string {
  return ms >= MINUTE
    ? `${Math.round(ms / MINUTE)} min`
    : `${Math.round(ms / 1000)} s`;
}
