import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from "homebridge";
import { SkodaApiClient } from "./api/client.js";
import { DEFAULT_RATE_LIMIT, RateBudget } from "./api/rateBudget.js";
import { parseVehicleConfig, type VehicleSettings } from "./config.js";
import { VehicleAccessory } from "./accessory/vehicleAccessory.js";
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

  private setUpVehicle(
    settings: VehicleSettings,
    uuid: string,
    log: Logger,
  ): void {
    const cached = this.cachedAccessories.get(uuid);
    const accessory =
      cached ?? new this.api.platformAccessory(settings.name, uuid);

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
