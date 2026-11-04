import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from "homebridge";
import { SkodaApiClient } from "./api/client.js";
import { DEFAULT_RATE_LIMIT, RateBudget } from "./api/rateBudget.js";
import {
  configuredVin,
  parseVehicleConfig,
  type VehicleSettings,
} from "./config.js";
import {
  VehicleAccessory,
  markUnavailable,
} from "./accessory/vehicleAccessory.js";
import { PLATFORM_NAME, PLUGIN_NAME, PLUGIN_VERSION } from "./settings.js";
import { createVehicleLogger, type Logger } from "./util/logger.js";
import { maskVin } from "./util/redact.js";
import { VehicleController } from "./vehicle/vehicleController.js";

export class SkodaPlatform implements DynamicPlatformPlugin {
  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private readonly controllers: VehicleController[] = [];

  constructor(
    private readonly log: Logging,
    private readonly config: PlatformConfig,
    private readonly api: API,
  ) {
    api.on("didFinishLaunching", () => {
      this.setUpVehicles();
    });
    api.on("shutdown", () => {
      for (const controller of this.controllers) {
        controller.stop();
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private setUpVehicles(): void {
    const rawVehicles: unknown[] = Array.isArray(this.config.vehicles)
      ? (this.config.vehicles as unknown[])
      : [];
    if (rawVehicles.length === 0) {
      this.log.warn("No vehicles configured.");
    }

    const activeUuids = new Set<string>();
    rawVehicles.forEach((raw, index) => {
      const result = parseVehicleConfig(raw, index);
      if (!result.ok) {
        for (const error of result.errors) {
          this.log.error(`Skipping vehicle: ${error}`);
        }
        this.keepCachedVehicle(raw, index, activeUuids);
        return;
      }
      const { settings } = result;
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${settings.vin}`);
      if (activeUuids.has(uuid)) {
        this.log.error(
          `Skipping vehicles[${index}]: VIN ${maskVin(settings.vin)} is configured twice`,
        );
        return;
      }
      activeUuids.add(uuid);

      const log = createVehicleLogger(this.log, settings.name, settings.vin, [
        settings.token,
        settings.spin,
      ]);
      for (const warning of result.warnings) {
        log.warn(warning);
      }
      this.setUpVehicle(settings, uuid, log);
    });

    for (const [uuid, accessory] of this.cachedAccessories) {
      if (!activeUuids.has(uuid)) {
        this.log.info(
          `Removing vehicle "${accessory.displayName}" that is no longer configured`,
        );
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory,
        ]);
      }
    }
  }

  /**
   * An entry that cannot be used, e.g. with an empty API key while the key is being replaced,
   * still names its vehicle. Its cached accessory stays registered, so HomeKit keeps the rooms,
   * names and automations, and answers "No Response" until the entry is fixed.
   */
  private keepCachedVehicle(
    raw: unknown,
    index: number,
    activeUuids: Set<string>,
  ): void {
    const vin = configuredVin(raw);
    if (!vin) {
      return;
    }
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${vin}`);
    const cached = this.cachedAccessories.get(uuid);
    if (cached && !activeUuids.has(uuid)) {
      activeUuids.add(uuid);
      markUnavailable(this.api.hap, cached);
      this.log.warn(
        `Keeping vehicle ${maskVin(vin)} in HomeKit, but not updating it until vehicles[${index}] is fixed`,
      );
    }
  }

  /** A cached vehicle keeps its old name unless the new one from the config is applied. */
  private rename(
    accessory: PlatformAccessory,
    name: string,
    log: Logger,
  ): void {
    log.info(`Renamed from "${accessory.displayName}"`);
    accessory.updateDisplayName(name);
    accessory
      .getService(this.api.hap.Service.AccessoryInformation)
      ?.setCharacteristic(this.api.hap.Characteristic.Name, name);
    this.api.updatePlatformAccessories([accessory]);
  }

  private setUpVehicle(
    settings: VehicleSettings,
    uuid: string,
    log: Logger,
  ): void {
    const cached = this.cachedAccessories.get(uuid);
    const accessory =
      cached ?? new this.api.platformAccessory(settings.name, uuid);
    if (cached && cached.displayName !== settings.name) {
      this.rename(cached, settings.name, log);
    }

    const client = new SkodaApiClient({
      token: settings.token,
      vin: settings.vin,
      budget: new RateBudget(),
      userAgent: `homebridge-skoda/${PLUGIN_VERSION}`,
      onKeyExpiry: (expiresAt) => {
        controller.noteKeyExpiry("API key", expiresAt);
      },
    });
    const controller = new VehicleController({
      client,
      log,
      pollingIntervalMinutes: settings.pollingIntervalMinutes,
    });
    this.controllers.push(controller);

    // A new vehicle is saved with its services when it is registered below.
    let registered = cached !== undefined;
    new VehicleAccessory({
      hap: this.api.hap,
      accessory,
      controller,
      settings,
      log,
      onServicesChanged: () => {
        if (registered) {
          this.api.updatePlatformAccessories([accessory]);
        }
      },
    });

    if (!cached) {
      // A new vehicle is published once the first poll has created its services. Services added
      // after publishing change the accessory while the Home app may be pairing it, and the Home
      // app then replaces the service names with generic ones ("Contact Sensor 2").
      const unsubscribe = controller.onUpdate((snapshot) => {
        if (!snapshot) {
          return;
        }
        unsubscribe();
        registered = true;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory,
        ]);
        log.info("Added vehicle");
      });
    }

    const pollsPerHour = Math.ceil(60 / settings.pollingIntervalMinutes);
    log.info(
      `Polling every ${settings.pollingIntervalMinutes} min (${pollsPerHour} of ${DEFAULT_RATE_LIMIT} requests per hour, ` +
        `${Math.max(0, DEFAULT_RATE_LIMIT - pollsPerHour)} left for commands)`,
    );
    controller.start();
  }
}
