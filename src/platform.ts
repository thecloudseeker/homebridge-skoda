import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from "homebridge";
import { SkodaApiClient } from "./api/client.js";
import { RateBudget } from "./api/rateBudget.js";
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
        settings.commandToken,
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
    let accessory = this.cachedAccessories.get(uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(settings.name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
        accessory,
      ]);
      log.info("Added vehicle");
    }

    // The rate limit applies per VIN, so both keys of a vehicle share one budget.
    const budget = new RateBudget();
    const userAgent = `homebridge-skoda/${PLUGIN_VERSION}`;
    const keyExpiry = (label: string) => (expiresAt: Date) => {
      controller.noteKeyExpiry(label, expiresAt);
    };
    const pollClient = new SkodaApiClient({
      token: settings.token,
      vin: settings.vin,
      budget,
      userAgent,
      onKeyExpiry: keyExpiry(
        settings.commandToken ? "polling API key" : "API key",
      ),
    });
    const commandClient = settings.commandToken
      ? new SkodaApiClient({
          token: settings.commandToken,
          vin: settings.vin,
          budget,
          userAgent,
          onKeyExpiry: keyExpiry("command API key"),
        })
      : pollClient;

    const controller = new VehicleController({
      pollClient,
      commandClient,
      log,
      pollingIntervalMinutes: settings.pollingIntervalMinutes,
      commandRefreshDelaySeconds: settings.commandRefreshDelaySeconds,
    });
    this.controllers.push(controller);

    new VehicleAccessory({
      hap: this.api.hap,
      accessory,
      controller,
      settings,
      log,
    });
    log.info(
      `Polling every ${settings.pollingIntervalMinutes} min${settings.commandToken ? ", separate command key" : ""}`,
    );
    controller.start();
  }
}
