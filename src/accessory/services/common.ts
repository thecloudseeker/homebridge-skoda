import type { API, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';
import type { SkodaApiClient } from '../../api/client.js';
import type { Vehicle } from '../../api/types.js';
import type { FeatureToggles, VehicleSettings } from '../../config.js';
import type { Logger } from '../../util/logger.js';
import type { VehicleSnapshot } from '../../vehicle/snapshot.js';
import type { CommandOptions, VehicleController } from '../../vehicle/vehicleController.js';

export type HAP = API['hap'];
export type ServiceType = WithUUID<typeof Service>;
type HapStatus = ConstructorParameters<HAP['HapStatusError']>[0];

/** `HAPStatus.SERVICE_COMMUNICATION_FAILURE` ("No Response"); the enum is const and type-only here. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- ambient const enum cannot be referenced
const SERVICE_COMMUNICATION_FAILURE = -70402 as HapStatus;
type CharacteristicType = Parameters<Service['updateCharacteristic']>[0];

export interface BindingContext {
  hap: HAP;
  accessory: PlatformAccessory;
  controller: VehicleController;
  settings: VehicleSettings;
  log: Logger;
}

/**
 * One HomeKit service backed by the vehicle cache. Values are pushed into the characteristics on
 * every cache update; HomeKit reads are answered by HAP from those values and never reach the API.
 */
export abstract class ServiceBinding {
  abstract readonly feature: keyof FeatureToggles;
  protected abstract readonly serviceType: ServiceType;
  protected abstract readonly subtype: string;
  protected abstract readonly displayName: string;
  protected service: Service | undefined;

  constructor(protected readonly ctx: BindingContext) {}

  /** Whether the service exists on the (possibly cached) accessory. */
  exists(): boolean {
    return this.ctx.accessory.getServiceById(this.serviceType, this.subtype) !== undefined;
  }

  /** Creates the service if needed and registers handlers once. */
  attach(): void {
    if (this.service) {
      return;
    }
    const { accessory, hap } = this.ctx;
    let service = accessory.getServiceById(this.serviceType, this.subtype);
    if (!service) {
      service = accessory.addService(this.serviceType, this.displayName, this.subtype);
      service.addOptionalCharacteristic(hap.Characteristic.ConfiguredName);
      service.setCharacteristic(hap.Characteristic.ConfiguredName, this.displayName);
      this.ctx.log.info(`Added ${this.displayName}`);
    }
    this.service = service;
    this.configure?.(service);
  }

  detach(): void {
    const service = this.ctx.accessory.getServiceById(this.serviceType, this.subtype);
    if (service) {
      this.ctx.accessory.removeService(service);
      this.ctx.log.info(`Removed ${this.displayName}`);
    }
    this.service = undefined;
  }

  update(snapshot: VehicleSnapshot | undefined, stale: boolean): void {
    if (!this.service) {
      return;
    }
    if (snapshot) {
      this.render(this.service, snapshot.vehicle);
    }
    if (this.hasStatusFault) {
      const { StatusFault } = this.ctx.hap.Characteristic;
      this.service.updateCharacteristic(StatusFault, stale ? StatusFault.GENERAL_FAULT : StatusFault.NO_FAULT);
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
  protected set(characteristic: CharacteristicType, value: CharacteristicValue | undefined): void {
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
   * characteristic is reverted to the cached value.
   */
  protected async command(
    label: string,
    send: (client: SkodaApiClient) => Promise<void>,
    optimistic?: (vehicle: Vehicle) => void,
    options?: CommandOptions,
  ): Promise<void> {
    try {
      await this.ctx.controller.runCommand(label, send, optimistic, options);
    } catch {
      setTimeout(() => {
        this.rerender();
      }, 500).unref();
      throw new this.ctx.hap.HapStatusError(SERVICE_COMMUNICATION_FAILURE);
    }
  }
}

/** Delays an action until the value has not changed for `delayMs` (sliders send many updates). */
export function debounce<T>(delayMs: number, action: (value: T) => void): (value: T) => void {
  let timer: NodeJS.Timeout | undefined;
  return (value: T) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      action(value);
    }, delayMs);
    timer.unref();
  };
}

/** Patches the charging part of the cached vehicle, creating it if needed. */
export function patchChargingStatus(vehicle: Vehicle, patch: NonNullable<NonNullable<Vehicle['charging']>['status']>): void {
  vehicle.charging ??= { isVehicleInSavedLocation: false };
  vehicle.charging.status = { ...vehicle.charging.status, ...patch };
}
