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
import {
  PluggedInBinding,
  PresenceBinding,
  contactBindings,
  removeLegacyLockSensor,
} from "./services/body.js";
import {
  ChargingBinding,
  ChargingLimitPresetBinding,
  removeUnusedChargingLimitServices,
} from "./services/charging.js";
import {
  ActiveVentilationBinding,
  AuxiliaryHeatingBinding,
  ClimateBinding,
} from "./services/climate.js";
import {
  SERVICE_COMMUNICATION_FAILURE,
  type BindingContext,
  type HAP,
  type ServiceBinding,
} from "./services/common.js";
import type { PlatformAccessory } from "homebridge";

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
  private lastSupportSummary: string | undefined;
  /**
   * The last definite answer per feature. An update that leaves support open (for example when a
   * notice such as `CHARGING_UNSUPPORTED` is missing from one response) keeps the previous answer
   * in the support log instead of dropping the feature from it.
   */
  private readonly knownSupport = new Map<keyof FeatureToggles, boolean>();

  constructor(private readonly ctx: BindingContext) {
    this.bindings = [
      new BatteryBinding(ctx),
      new StateOfChargeSensorBinding(ctx),
      new FuelBinding(ctx),
      new FuelLevelSensorBinding(ctx),
      new ChargingBinding(ctx),
      ...ctx.settings.chargingLimits.map(
        (percent) => new ChargingLimitPresetBinding(ctx, percent),
      ),
      new ClimateBinding(ctx),
      new AuxiliaryHeatingBinding(ctx),
      new ActiveVentilationBinding(ctx),
      new PluggedInBinding(ctx),
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

    const removedLock = removeLegacyLockSensor(ctx);
    if (removeUnusedChargingLimitServices(ctx) || removedLock) {
      ctx.onServicesChanged?.();
    }
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
    const support = this.countUnsupported(snapshot, newUpdate);
    let changed = false;
    for (const binding of this.bindings) {
      const enabled = this.ctx.settings.features[binding.feature];
      const supported = support.get(binding.feature);
      if (enabled && supported === false && binding.exists()) {
        const count = this.unsupportedUpdates.get(binding.feature) ?? 0;
        if (count < REMOVE_AFTER_UNSUPPORTED_UPDATES) {
          binding.attach();
          binding.update(snapshot, stale);
          continue;
        }
      }
      if (!enabled || supported === false) {
        changed = binding.detach() || changed;
        continue;
      }
      if (supported === true || binding.exists()) {
        changed = binding.attach() || changed;
        binding.update(snapshot, stale);
      }
    }
    if (changed) {
      this.ctx.onServicesChanged?.();
    }
    if (snapshot && newUpdate) {
      this.logSupport();
    }
  }

  /**
   * Works out support per feature and counts the updates that report a shown feature as
   * unsupported. Several services can share a feature (the charge limit switches), so each
   * feature is counted once per update, not once per service.
   */
  private countUnsupported(
    snapshot: VehicleSnapshot | undefined,
    newUpdate: boolean,
  ): Map<keyof FeatureToggles, boolean | undefined> {
    const support = new Map<keyof FeatureToggles, boolean | undefined>();
    for (const binding of this.bindings) {
      const { feature } = binding;
      if (support.has(feature)) {
        continue;
      }
      const supported = snapshot
        ? featureSupport(snapshot, feature)
        : undefined;
      support.set(feature, supported);
      if (supported !== undefined && newUpdate) {
        this.knownSupport.set(feature, supported);
      }
      const enabled = this.ctx.settings.features[feature];
      const shown = this.bindings.some(
        (other) => other.feature === feature && other.exists(),
      );
      if (enabled && supported === false && shown) {
        if (newUpdate) {
          this.unsupportedUpdates.set(
            feature,
            (this.unsupportedUpdates.get(feature) ?? 0) + 1,
          );
        }
      } else if (!enabled || supported !== undefined) {
        // Supported again, turned off, or already removed: start counting from zero.
        this.unsupportedUpdates.delete(feature);
      }
    }
    return support;
  }

  /**
   * Logs what the vehicle supports whenever that changes, so users can see which features exist
   * for their vehicle without trying each one, and which of them are turned off in the config.
   */
  private logSupport(): void {
    // Several bindings can share a feature (the charge limit switches); list each feature once.
    const supported = this.bindings.filter(
      (binding, index, all) =>
        this.knownSupport.get(binding.feature) === true &&
        all.findIndex((other) => other.feature === binding.feature) === index,
    );
    const { features } = this.ctx.settings;
    const shown = supported.filter((binding) => features[binding.feature]);
    const off = supported.filter((binding) => !features[binding.feature]);
    let summary = `Supported by the vehicle: ${shown.map((b) => b.name).join(", ") || "none"}`;
    if (off.length > 0) {
      summary += `. Also supported, but turned off: ${off.map((b) => `${b.name} (${this.howToTurnOn(b.feature)})`).join(", ")}`;
    }
    if (summary !== this.lastSupportSummary) {
      this.lastSupportSummary = summary;
      this.ctx.log.info(summary);
    }
  }

  /** Features that need more config are turned off automatically without it; name what is missing. */
  private howToTurnOn(feature: keyof FeatureToggles): string {
    const { settings } = this.ctx;
    if (feature === "auxiliaryHeating" && !settings.spin) {
      return "needs the S-PIN";
    }
    if (feature === "presence" && !settings.home) {
      return "needs the home location";
    }
    return `features.${feature}`;
  }
}

/**
 * For a cached vehicle that is kept but not updated: every read and write answers "No Response",
 * so the Home app shows the vehicle as unreachable instead of switches that seem to work.
 */
export function markUnavailable(hap: HAP, accessory: PlatformAccessory): void {
  const fail = () => {
    throw new hap.HapStatusError(SERVICE_COMMUNICATION_FAILURE);
  };
  for (const service of accessory.services) {
    if (service.UUID === hap.Service.AccessoryInformation.UUID) {
      continue;
    }
    for (const characteristic of service.characteristics) {
      characteristic.onGet(fail).onSet(fail);
    }
  }
}
