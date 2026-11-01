import type { Service } from "homebridge";
import type { Vehicle } from "../../api/types.js";
import {
  batteryValues,
  fuelLevel,
  fuelValues,
  stateOfCharge,
} from "../../vehicle/mapping.js";
import { ServiceBinding, type ServiceType } from "./common.js";

/** Battery: level, charging state and low battery below the configured threshold. */
export class BatteryBinding extends ServiceBinding {
  readonly feature = "battery";
  protected readonly serviceType: ServiceType = this.ctx.hap.Service.Battery;
  protected readonly subtype = "battery";
  protected readonly displayName = "Battery";

  protected render(_service: Service, vehicle: Vehicle): void {
    const { BatteryLevel, ChargingState, StatusLowBattery } =
      this.ctx.hap.Characteristic;
    const values = batteryValues(
      vehicle,
      this.ctx.settings.lowBatteryThreshold,
    );
    this.set(BatteryLevel, values.level);
    if (values.charging !== undefined) {
      this.set(
        ChargingState,
        values.charging ? ChargingState.CHARGING : ChargingState.NOT_CHARGING,
      );
    }
    if (values.low !== undefined) {
      this.set(
        StatusLowBattery,
        values.low
          ? StatusLowBattery.BATTERY_LEVEL_LOW
          : StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );
    }
  }
}

/** Humidity sensor that mirrors the state of charge, because HomeKit cannot trigger on battery levels. */
export class StateOfChargeSensorBinding extends ServiceBinding {
  readonly feature = "stateOfChargeSensor";
  protected readonly serviceType: ServiceType =
    this.ctx.hap.Service.HumiditySensor;
  protected readonly subtype = "state-of-charge";
  protected readonly displayName = "State of Charge";

  protected override get hasStatusFault(): boolean {
    return true;
  }

  protected render(_service: Service, vehicle: Vehicle): void {
    this.set(
      this.ctx.hap.Characteristic.CurrentRelativeHumidity,
      stateOfCharge(vehicle),
    );
  }
}

/**
 * Battery service for combustion vehicles: the level is the fuel level, low below the configured
 * threshold. HomeKit has no fuel service; hybrids show their high-voltage battery instead.
 */
export class FuelBinding extends ServiceBinding {
  readonly feature = "fuelLevel";
  protected readonly serviceType: ServiceType = this.ctx.hap.Service.Battery;
  protected readonly subtype = "fuel";
  protected readonly displayName = "Fuel";

  protected override configure(service: Service): void {
    const { ChargingState } = this.ctx.hap.Characteristic;
    service.updateCharacteristic(ChargingState, ChargingState.NOT_CHARGEABLE);
  }

  protected render(_service: Service, vehicle: Vehicle): void {
    const { BatteryLevel, StatusLowBattery } = this.ctx.hap.Characteristic;
    const values = fuelValues(vehicle, this.ctx.settings.lowBatteryThreshold);
    this.set(BatteryLevel, values.level);
    if (values.low !== undefined) {
      this.set(
        StatusLowBattery,
        values.low
          ? StatusLowBattery.BATTERY_LEVEL_LOW
          : StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );
    }
  }
}

/** Humidity sensor that mirrors the fuel level, because HomeKit cannot trigger on battery levels. */
export class FuelLevelSensorBinding extends ServiceBinding {
  readonly feature = "fuelLevelSensor";
  protected readonly serviceType: ServiceType =
    this.ctx.hap.Service.HumiditySensor;
  protected readonly subtype = "fuel-level";
  protected readonly displayName = "Fuel Level";

  protected override get hasStatusFault(): boolean {
    return true;
  }

  protected render(_service: Service, vehicle: Vehicle): void {
    this.set(
      this.ctx.hap.Characteristic.CurrentRelativeHumidity,
      fuelLevel(vehicle),
    );
  }
}
