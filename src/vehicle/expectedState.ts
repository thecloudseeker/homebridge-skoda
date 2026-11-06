import type { OperationName, Vehicle } from "../api/types.js";
import type { VehicleSnapshot } from "./snapshot.js";

/** An expected state is dropped after this long, even if the vehicle never reports back. */
export const EXPECTED_STATE_TTL_MS = 15 * 60_000;

/** Parts that carry a `carCapturedTimestamp`, which tells when the vehicle last reported them. */
export type ReportedPart =
  "charging" | "airConditioning" | "auxiliaryHeating" | "activeVentilation";

export interface OptimisticPatch {
  /** The part the command changes. */
  part: ReportedPart;
  apply: (vehicle: Vehicle) => void;
}

interface PendingPatch extends OptimisticPatch {
  sentAt: number;
  /** `carCapturedTimestamp` of the part when the command was sent. */
  capturedBefore: string | undefined;
}

/**
 * What the plugin knows better than the last poll: the expected state after accepted commands,
 * and operations the vehicle rejected as unsupported.
 *
 * The vehicle reports new state with a delay, so an accepted command's patch is applied to every
 * snapshot until the vehicle reports the changed part again (a `carCapturedTimestamp` after the
 * command), for at most 15 minutes. No extra request is spent on confirming it.
 */
export class ExpectedState {
  private pending: PendingPatch[] = [];
  private readonly rejected = new Set<OperationName>();

  /**
   * Records the expected state of an accepted command. Returns the current snapshot with it
   * applied, or undefined without a snapshot.
   */
  add(
    patch: OptimisticPatch,
    current: VehicleSnapshot | undefined,
    now = Date.now(),
  ): VehicleSnapshot | undefined {
    this.pending.push({
      ...patch,
      sentAt: now,
      capturedBefore: capturedAt(current?.vehicle, patch.part),
    });
    if (!current) {
      return undefined;
    }
    const patched = structuredClone(current);
    patch.apply(patched.vehicle);
    return patched;
  }

  /** Remembered until restart: the vehicle lacks the capability, so retrying does not help. */
  reject(operations: readonly OperationName[]): void {
    for (const name of operations) {
      this.rejected.add(name);
    }
  }

  /** The snapshot without the rejected operations. */
  withoutRejected(snapshot: VehicleSnapshot): VehicleSnapshot {
    if (this.rejected.size === 0) {
      return snapshot;
    }
    const patched = structuredClone(snapshot);
    this.removeRejected(patched.vehicle);
    return patched;
  }

  /**
   * Applies what is still expected to a new snapshot. Patches the vehicle has confirmed, or that
   * are older than 15 minutes, are dropped first.
   */
  apply(snapshot: VehicleSnapshot): VehicleSnapshot {
    const now = snapshot.fetchedAt;
    this.pending = this.pending.filter(
      (patch) =>
        now - patch.sentAt < EXPECTED_STATE_TTL_MS &&
        !reportedSince(snapshot.vehicle, patch),
    );
    if (this.pending.length === 0 && this.rejected.size === 0) {
      return snapshot;
    }
    const patched = structuredClone(snapshot);
    for (const patch of this.pending) {
      patch.apply(patched.vehicle);
    }
    this.removeRejected(patched.vehicle);
    return patched;
  }

  private removeRejected(vehicle: Vehicle): void {
    if (vehicle.operations && this.rejected.size > 0) {
      vehicle.operations = vehicle.operations.filter(
        (operation) => !this.rejected.has(operation.name),
      );
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
