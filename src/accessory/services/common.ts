import type {
  API,
  CharacteristicValue,
  PlatformAccessory,
  Service,
  WithUUID,
} from "homebridge";
import type { SkodaApiClient } from "../../api/client.js";
import type { Vehicle } from "../../api/types.js";
import type { FeatureToggles, VehicleSettings } from "../../config.js";
import type { Logger } from "../../util/logger.js";
import type { VehicleSnapshot } from "../../vehicle/snapshot.js";
import type {
  CommandOptions,
  VehicleController,
} from "../../vehicle/vehicleController.js";

export type HAP = API["hap"];
export type ServiceType = WithUUID<typeof Service>;
type HapStatus = ConstructorParameters<HAP["HapStatusError"]>[0];

/** `HAPStatus.SERVICE_COMMUNICATION_FAILURE` ("No Response"); the enum is const and type-only here. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- ambient const enum cannot be referenced
export const SERVICE_COMMUNICATION_FAILURE = -70402 as HapStatus;
type CharacteristicType = Parameters<Service["updateCharacteristic"]>[0];

export interface BindingContext {
  hap: HAP;
  accessory: PlatformAccessory;
  controller: VehicleController;
  settings: VehicleSettings;
  log: Logger;
  /** Called after services were added or removed, so Homebridge can save its accessory cache. */
  onServicesChanged?: () => void;
}

/**
 * One HomeKit service backed by the vehicle cache. Values are pushed into the characteristics on
 * every cache update; HomeKit reads are answered from those values and never reach the API.
 *
 * While the data is stale (no update for three polling intervals), sensors show a fault. Services
 * without `StatusFault` (the controls and the battery) answer reads and writes with "No Response"
 * instead, so the Home app never shows an old state as current.
 */
export abstract class ServiceBinding {
  abstract readonly feature: keyof FeatureToggles;
  protected abstract readonly serviceType: ServiceType;
  protected abstract readonly subtype: string;
  protected abstract readonly displayName: string;
  protected service: Service | undefined;
  private stale = false;
  /** Characteristics whose reads already check for stale data. */
  private readonly guarded = new WeakSet<object>();

  constructor(protected readonly ctx: BindingContext) {}

  /** Name of the service in HomeKit. */
  get name(): string {
    return this.displayName;
  }

  /** Whether the service exists on the (possibly cached) accessory. */
  exists(): boolean {
    return (
      this.ctx.accessory.getServiceById(this.serviceType, this.subtype) !==
      undefined
    );
  }

  /** Creates the service if needed and registers handlers once. Returns whether it was added. */
  attach(): boolean {
    if (this.service) {
      return false;
    }
    const { accessory, hap } = this.ctx;
    let service = accessory.getServiceById(this.serviceType, this.subtype);
    const added = !service;
    if (!service) {
      service = accessory.addService(
        this.serviceType,
        this.displayName,
        this.subtype,
      );
      service.addOptionalCharacteristic(hap.Characteristic.ConfiguredName);
      service.setCharacteristic(
        hap.Characteristic.ConfiguredName,
        this.displayName,
      );
      this.ctx.log.info(`Added ${this.displayName}`);
    }
    this.service = service;
    this.configure?.(service);
    return added;
  }

  /** Removes the service if it exists. Returns whether it was removed. */
  detach(): boolean {
    const service = this.ctx.accessory.getServiceById(
      this.serviceType,
      this.subtype,
    );
    this.service = undefined;
    if (!service) {
      return false;
    }
    this.ctx.accessory.removeService(service);
    this.ctx.log.info(`Removed ${this.displayName}`);
    return true;
  }

  update(snapshot: VehicleSnapshot | undefined, stale: boolean): void {
    if (!this.service) {
      return;
    }
    this.stale = stale;
    if (snapshot) {
      this.render(this.service, snapshot.vehicle);
    }
    if (!this.hasStatusFault) {
      // After rendering, so characteristics that render added are covered too.
      this.guardReads(this.service);
    }
    if (this.hasStatusFault) {
      const { StatusFault } = this.ctx.hap.Characteristic;
      this.service.updateCharacteristic(
        StatusFault,
        stale ? StatusFault.GENERAL_FAULT : StatusFault.NO_FAULT,
      );
    }
  }

  /** Throws "No Response" for HomeKit while the data is stale. */
  protected assertFresh(): void {
    if (this.stale) {
      throw new this.ctx.hap.HapStatusError(SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /** Names do not come from the vehicle and stay readable, so the Home app keeps them. */
  private guardReads(service: Service): void {
    const { Name, ConfiguredName } = this.ctx.hap.Characteristic;
    for (const characteristic of service.characteristics) {
      if (
        this.guarded.has(characteristic) ||
        characteristic.UUID === Name.UUID ||
        characteristic.UUID === ConfiguredName.UUID
      ) {
        continue;
      }
      this.guarded.add(characteristic);
      characteristic.onGet(() => {
        this.assertFresh();
        return characteristic.value;
      });
    }
  }

  /** Services that support `StatusFault` signal stale data with it. */
  protected get hasStatusFault(): boolean {
    return false;
  }

  /** Sets characteristic props and registers set handlers. */
  protected configure?(service: Service): void;

  /** Pushes the cached values into the characteristics. */
  protected abstract render(service: Service, vehicle: Vehicle): void;

  /** Updates a characteristic only when the API reported a value. */
  protected set(
    characteristic: CharacteristicType,
    value: CharacteristicValue | undefined,
  ): void {
    if (value !== undefined) {
      this.service?.updateCharacteristic(characteristic, value);
    }
  }

  /** Re-renders from the cache, e.g. to revert a rejected change in the Home app. */
  protected rerender(): void {
    const snapshot = this.ctx.controller.snapshot;
    if (this.service && snapshot) {
      this.render(this.service, snapshot.vehicle);
    }
  }

  /**
   * Runs a command for a set handler. A failure is reported to HomeKit as "no response" and the
   * characteristic is reverted to the cached value. With stale data nothing is sent.
   */
  protected async command(
    label: string,
    send: (client: SkodaApiClient) => Promise<void>,
    options?: CommandOptions,
  ): Promise<void> {
    this.assertFresh();
    try {
      await this.ctx.controller.runCommand(label, send, options);
    } catch {
      setTimeout(() => {
        this.rerender();
      }, 500).unref();
      throw new this.ctx.hap.HapStatusError(SERVICE_COMMUNICATION_FAILURE);
    }
  }
}

/**
 * Delays an action until the value has not changed for `delayMs` (sliders send many updates). A
 * waiting action is dropped when `signal` aborts, e.g. when Homebridge shuts down.
 */
export function debounce<T>(
  delayMs: number,
  action: (value: T) => void,
  signal?: AbortSignal,
): (value: T) => void {
  let timer: NodeJS.Timeout | undefined;
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
  });
  return (value: T) => {
    clearTimeout(timer);
    if (signal?.aborted) {
      return;
    }
    timer = setTimeout(() => {
      action(value);
    }, delayMs);
    timer.unref();
  };
}

/** Waits `ms`; resolves `false` right away when `signal` aborts first. */
export function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Patches the charging part of the cached vehicle, creating it if needed. */
export function patchChargingStatus(
  vehicle: Vehicle,
  patch: NonNullable<NonNullable<Vehicle["charging"]>["status"]>,
): void {
  vehicle.charging ??= { isVehicleInSavedLocation: false };
  vehicle.charging.status = { ...vehicle.charging.status, ...patch };
}
