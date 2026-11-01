import type { FeatureToggles } from "../config.js";
import { maskVin } from "../util/redact.js";
import { PLUGIN_VERSION } from "../settings.js";
import { featureSupport, type VehicleSnapshot } from "../vehicle/snapshot.js";
import {
  BatteryBinding,
  FuelBinding,
  FuelLevelSensorBinding,
  StateOfChargeSensorBinding,
} from "./services/battery.js";
import { PresenceBinding, contactBindings } from "./services/body.js";
import { ChargingBinding, ChargingLimitBinding } from "./services/charging.js";
import {
  ActiveVentilationBinding,
  AuxiliaryHeatingBinding,
  ClimateBinding,
} from "./services/climate.js";
import type { BindingContext, ServiceBinding } from "./services/common.js";

/** A service is removed only after this many updates report it unsupported, with none supported in between. */
const REMOVE_AFTER_UNSUPPORTED_UPDATES = 2;

/**
 * One HomeKit accessory per vehicle. Services are created only for features that are enabled in
 * the config and that the vehicle reports as supported, and removed when two updates report them
 * unsupported, so a single odd response does not cost the user the service's room and automations. While support is unknown (e.g. the API is unreachable), cached
 * services are kept as they are.
 */
export class VehicleAccessory {
  private readonly bindings: ServiceBinding[];
  private readonly unsupportedUpdates = new Map<keyof FeatureToggles, number>();
  /** `fetchedAt` of the last snapshot, so optimistic updates and stale notices are not counted. */
  private lastFetchedAt: number | undefined;

  constructor(private readonly ctx: BindingContext) {
    this.bindings = [
      new BatteryBinding(ctx),
      new StateOfChargeSensorBinding(ctx),
      new FuelBinding(ctx),
      new FuelLevelSensorBinding(ctx),
      new ChargingBinding(ctx),
      new ChargingLimitBinding(ctx),
      new ClimateBinding(ctx),
      new AuxiliaryHeatingBinding(ctx),
      new ActiveVentilationBinding(ctx),
      new PresenceBinding(ctx),
      ...contactBindings(ctx),
    ];

    const { Characteristic, Service } = ctx.hap;
    ctx.accessory
      .getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, "Škoda")
      .setCharacteristic(Characteristic.Model, "MyŠkoda vehicle")
      .setCharacteristic(Characteristic.SerialNumber, maskVin(ctx.settings.vin))
      .setCharacteristic(Characteristic.FirmwareRevision, PLUGIN_VERSION);

    this.sync(ctx.controller.snapshot);
    ctx.controller.onUpdate((snapshot) => {
      this.sync(snapshot);
    });
  }

  private sync(snapshot: VehicleSnapshot | undefined): void {
    const stale = this.ctx.controller.isStale();
    const newUpdate =
      snapshot !== undefined && snapshot.fetchedAt !== this.lastFetchedAt;
    this.lastFetchedAt = snapshot?.fetchedAt ?? this.lastFetchedAt;
    let changed = false;
    for (const binding of this.bindings) {
      const enabled = this.ctx.settings.features[binding.feature];
      const supported = snapshot
        ? featureSupport(snapshot, binding.feature)
        : undefined;
      if (enabled && supported === false && binding.exists()) {
        const count =
          (this.unsupportedUpdates.get(binding.feature) ?? 0) +
          (newUpdate ? 1 : 0);
        this.unsupportedUpdates.set(binding.feature, count);
        if (count < REMOVE_AFTER_UNSUPPORTED_UPDATES) {
          binding.attach();
          binding.update(snapshot, stale);
          continue;
        }
      }
      if (!enabled || supported === false) {
        this.unsupportedUpdates.delete(binding.feature);
        changed = binding.detach() || changed;
        continue;
      }
      if (supported === true) {
        this.unsupportedUpdates.delete(binding.feature);
      }
      if (supported === true || binding.exists()) {
        changed = binding.attach() || changed;
        binding.update(snapshot, stale);
      }
    }
    if (changed) {
      this.ctx.onServicesChanged?.();
    }
  }
}
