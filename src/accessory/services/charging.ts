import type { CharacteristicValue, Service } from "homebridge";
import type { Vehicle } from "../../api/types.js";
import {
  chargingLimit,
  isCharging,
  isPlugConnected,
} from "../../vehicle/mapping.js";
import type { CommandOptions } from "../../vehicle/vehicleController.js";
import {
  ServiceBinding,
  patchChargingStatus,
  type BindingContext,
  type ServiceType,
} from "./common.js";

/** Outlet: On starts and stops charging, OutletInUse shows whether the cable is plugged in. */
export class ChargingBinding extends ServiceBinding {
  readonly feature = "charging";
  protected readonly serviceType: ServiceType = this.ctx.hap.Service.Outlet;
  protected readonly subtype = "charging";
  protected readonly displayName = "Charging";

  protected override configure(service: Service): void {
    service
      .getCharacteristic(this.ctx.hap.Characteristic.On)
      .onSet(async (value: CharacteristicValue) => {
        if (value === true) {
          await this.command(
            "Start charging",
            (client) => client.startCharging(),
            {
              operations: ["startCharging"],
              optimistic: {
                part: "charging",
                apply: (vehicle) => {
                  patchChargingStatus(vehicle, { state: "CHARGING" });
                },
              },
            },
          );
        } else {
          await this.command(
            "Stop charging",
            (client) => client.stopCharging(),
            {
              operations: ["stopCharging"],
              optimistic: {
                part: "charging",
                apply: (vehicle) => {
                  patchChargingStatus(vehicle, {
                    state: "READY_FOR_CHARGING",
                    chargePowerInKw: 0,
                  });
                },
              },
            },
          );
        }
      });
  }

  protected render(_service: Service, vehicle: Vehicle): void {
    const { On, OutletInUse } = this.ctx.hap.Characteristic;
    this.set(On, isCharging(vehicle));
    this.set(OutletInUse, isPlugConnected(vehicle));
  }
}

/** The command options for a new charging limit. */
function chargingLimitOptions(percent: number): CommandOptions {
  return {
    operations: ["setChargingLimit"],
    optimistic: {
      part: "charging",
      apply: (vehicle) => {
        vehicle.charging ??= { isVehicleInSavedLocation: false };
        vehicle.charging.settings = {
          ...vehicle.charging.settings,
          targetStateOfChargeInPercent: percent,
        };
      },
    },
  };
}

const PRESET_SUBTYPE = /^charging-limit-(\d+)$/;

/**
 * One switch per configured charging limit. A switch is on while the vehicle reports its limit;
 * turning it on sets that limit, which turns the others off. It cannot be turned off directly,
 * because "no limit" does not exist. A limit set in the MyŠkoda app that has no switch shows all
 * switches off.
 */
export class ChargingLimitPresetBinding extends ServiceBinding {
  readonly feature = "chargingLimitPresets";
  protected readonly serviceType: ServiceType = this.ctx.hap.Service.Switch;
  protected readonly subtype: string;
  protected readonly displayName: string;

  constructor(
    ctx: BindingContext,
    private readonly percent: number,
  ) {
    super(ctx);
    this.subtype = `charging-limit-${percent}`;
    this.displayName = `Charge Limit ${percent} %`;
  }

  /** All switches together form one feature in the support log. */
  override get name(): string {
    return "Charge Limit Switches";
  }

  protected override configure(service: Service): void {
    service
      .getCharacteristic(this.ctx.hap.Characteristic.On)
      .onSet(async (value: CharacteristicValue) => {
        this.assertFresh();
        if (value !== true) {
          // There is no "no limit"; show the reported limit again.
          setTimeout(() => {
            this.rerender();
          }, 500).unref();
          return;
        }
        const current = this.ctx.controller.snapshot?.vehicle;
        if (current && chargingLimit(current) === this.percent) {
          return;
        }
        await this.command(
          `Set charging limit to ${this.percent} %`,
          (client) => client.setChargingLimit(this.percent),
          chargingLimitOptions(this.percent),
        );
      });
  }

  protected render(_service: Service, vehicle: Vehicle): void {
    const limit = chargingLimit(vehicle);
    this.set(
      this.ctx.hap.Characteristic.On,
      limit === undefined ? undefined : limit === this.percent,
    );
  }
}

/**
 * Removes switches for limits that are no longer configured, and the charge limit lightbulb of
 * versions before 0.5.0. Returns whether a service was removed. Switches for configured limits are
 * added and removed with the feature like any other service.
 */
export function removeUnusedChargingLimitServices(
  ctx: BindingContext,
): boolean {
  const { accessory, hap, settings, log } = ctx;
  const lightbulb = accessory.getServiceById(
    hap.Service.Lightbulb,
    "charging-limit",
  );
  if (lightbulb) {
    accessory.removeService(lightbulb);
    log.info("Replaced the Charge Limit lightbulb with charge limit switches");
  }
  const unused = accessory.services.filter((service) => {
    const match = PRESET_SUBTYPE.exec(service.subtype ?? "");
    return (
      service.UUID === hap.Service.Switch.UUID &&
      match !== null &&
      !settings.chargingLimits.includes(Number(match[1]))
    );
  });
  for (const service of unused) {
    accessory.removeService(service);
    log.info(`Removed ${service.displayName}`);
  }
  return lightbulb !== undefined || unused.length > 0;
}
