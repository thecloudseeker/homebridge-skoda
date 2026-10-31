import type { CharacteristicValue, Service } from "homebridge";
import type { Vehicle } from "../../api/types.js";
import {
  CLIMATE_TEMPERATURE_MAX,
  CLIMATE_TEMPERATURE_MIN,
  CLIMATE_TEMPERATURE_STEP,
  clampTemperature,
} from "../../config.js";
import {
  climateValues,
  isActiveVentilationOn,
  isAuxiliaryHeatingOn,
} from "../../vehicle/mapping.js";
import { ServiceBinding, debounce, type ServiceType } from "./common.js";

const SLIDER_DEBOUNCE_MS = 3000;
/** Pause between stop and start when the temperature changes while running; undocumented by the API. */
const RESTART_PAUSE_MS = 10_000;

/**
 * Heater cooler for the air conditioning. The API reports no cabin temperature, so the current
 * temperature mirrors the target temperature. The API has no heat/cool modes, so the target state
 * is fixed to AUTO and both thresholds always hold the same target temperature.
 */
export class ClimateBinding extends ServiceBinding {
  readonly feature = "climate";
  protected readonly serviceType: ServiceType =
    this.ctx.hap.Service.HeaterCooler;
  protected readonly subtype = "climate";
  protected readonly displayName = "Climate";

  /** Temperature chosen in HomeKit that the vehicle has not confirmed yet. */
  private pendingCelsius: number | undefined;

  private readonly applyTemperature = debounce(
    SLIDER_DEBOUNCE_MS,
    (celsius: number) => {
      void this.restartWithTemperature(celsius);
    },
  );

  protected override configure(service: Service): void {
    const { Characteristic } = this.ctx.hap;
    const temperatureProps = {
      minValue: CLIMATE_TEMPERATURE_MIN,
      maxValue: CLIMATE_TEMPERATURE_MAX,
      minStep: CLIMATE_TEMPERATURE_STEP,
    };
    service
      .getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps(temperatureProps);
    service
      .getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps(temperatureProps);
    service
      .getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .setProps({ validValues: [Characteristic.TargetHeaterCoolerState.AUTO] });
    service.updateCharacteristic(
      Characteristic.TargetHeaterCoolerState,
      Characteristic.TargetHeaterCoolerState.AUTO,
    );
    this.showTemperature(this.ctx.settings.climateTemperature);

    service
      .getCharacteristic(Characteristic.Active)
      .onSet(async (value: CharacteristicValue) => {
        if (value === Characteristic.Active.ACTIVE) {
          await this.start();
        } else {
          await this.command(
            "Stop air conditioning",
            (client) => client.stopAirConditioning(),
            (vehicle) => {
              if (vehicle.airConditioning) {
                vehicle.airConditioning.state = "OFF";
              }
            },
          );
        }
      });

    const onThreshold = (value: CharacteristicValue) => {
      const celsius = clampTemperature(Number(value));
      this.pendingCelsius = celsius;
      setTimeout(() => {
        this.showTemperature(celsius);
      }, 100).unref();
      this.applyTemperature(celsius);
    };
    service
      .getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .onSet(onThreshold);
    service
      .getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .onSet(onThreshold);
  }

  protected render(_service: Service, vehicle: Vehicle): void {
    const { Active, CurrentHeaterCoolerState } = this.ctx.hap.Characteristic;
    const values = climateValues(vehicle);
    if (values.active !== undefined) {
      this.set(Active, values.active ? Active.ACTIVE : Active.INACTIVE);
    }
    if (values.mode !== undefined) {
      const states = {
        INACTIVE: CurrentHeaterCoolerState.INACTIVE,
        IDLE: CurrentHeaterCoolerState.IDLE,
        HEATING: CurrentHeaterCoolerState.HEATING,
        COOLING: CurrentHeaterCoolerState.COOLING,
      };
      this.set(CurrentHeaterCoolerState, states[values.mode]);
    }
    if (
      this.pendingCelsius !== undefined &&
      values.targetCelsius === this.pendingCelsius
    ) {
      this.pendingCelsius = undefined;
    }
    this.showTemperature(this.targetCelsius(vehicle));
  }

  private targetCelsius(vehicle: Vehicle | undefined): number {
    const reported = vehicle ? climateValues(vehicle).targetCelsius : undefined;
    return (
      this.pendingCelsius ??
      (reported === undefined
        ? this.ctx.settings.climateTemperature
        : clampTemperature(reported))
    );
  }

  private showTemperature(celsius: number): void {
    const {
      CurrentTemperature,
      HeatingThresholdTemperature,
      CoolingThresholdTemperature,
    } = this.ctx.hap.Characteristic;
    this.set(CurrentTemperature, celsius);
    this.set(HeatingThresholdTemperature, celsius);
    this.set(CoolingThresholdTemperature, celsius);
  }

  private async start(): Promise<void> {
    const celsius = this.targetCelsius(this.ctx.controller.snapshot?.vehicle);
    const { airConditioningWithoutExternalPower } = this.ctx.settings;
    await this.command(
      `Start air conditioning at ${celsius} °C`,
      (client) =>
        client.startAirConditioning({
          targetTemperature: { value: celsius, unit: "CELSIUS" },
          ...(airConditioningWithoutExternalPower === undefined
            ? {}
            : { airConditioningWithoutExternalPower }),
        }),
      (vehicle) => {
        // Heating or cooling is not known until the vehicle reports back.
        vehicle.airConditioning = {
          ...vehicle.airConditioning,
          state: "VENTILATION",
          targetTemperature: { value: celsius, unit: "CELSIUS" },
        };
      },
    );
  }

  /** A new temperature only takes effect on a restart; while off it is kept for the next start. */
  private async restartWithTemperature(celsius: number): Promise<void> {
    const vehicle = this.ctx.controller.snapshot?.vehicle;
    if (!vehicle || climateValues(vehicle).active !== true) {
      this.ctx.log.info(
        `Target temperature ${celsius} °C will be used on the next start`,
      );
      return;
    }
    try {
      await this.ctx.controller.runCommand(
        "Stop air conditioning for new temperature",
        (client) => client.stopAirConditioning(),
      );
      await new Promise((resolve) =>
        setTimeout(resolve, RESTART_PAUSE_MS).unref(),
      );
      await this.start();
    } catch {
      this.rerender();
    }
  }
}

/** Switch for the auxiliary heating. Needs the S-PIN, which is sent with every start. */
export class AuxiliaryHeatingBinding extends ServiceBinding {
  readonly feature = "auxiliaryHeating";
  protected readonly serviceType: ServiceType = this.ctx.hap.Service.Switch;
  protected readonly subtype = "auxiliary-heating";
  protected readonly displayName = "Auxiliary Heating";

  protected override configure(service: Service): void {
    service
      .getCharacteristic(this.ctx.hap.Characteristic.On)
      .onSet(async (value: CharacteristicValue) => {
        const { spin, auxiliaryHeatingDurationMinutes } = this.ctx.settings;
        if (value === true && spin) {
          await this.command(
            "Start auxiliary heating",
            (client) =>
              client.startAuxiliaryHeating({
                spin,
                ...(auxiliaryHeatingDurationMinutes === undefined
                  ? {}
                  : {
                      durationInSeconds: auxiliaryHeatingDurationMinutes * 60,
                    }),
              }),
            (vehicle) => {
              vehicle.auxiliaryHeating = {
                ...vehicle.auxiliaryHeating,
                state: "HEATING_AUXILIARY",
              };
            },
          );
        } else if (value !== true) {
          await this.command(
            "Stop auxiliary heating",
            (client) => client.stopAuxiliaryHeating(),
            (vehicle) => {
              vehicle.auxiliaryHeating = {
                ...vehicle.auxiliaryHeating,
                state: "OFF",
              };
            },
          );
        }
      });
  }

  protected render(_service: Service, vehicle: Vehicle): void {
    this.set(this.ctx.hap.Characteristic.On, isAuxiliaryHeatingOn(vehicle));
  }
}

/**
 * Switch for the active ventilation. It always shows the reported state, like the MyŠkoda app.
 * Observed with a live vehicle: a ventilation started through the Public API runs, but the API
 * (and the app) keep reporting OFF for its whole run, while one started in the app is reported
 * as VENTILATION. After a command the switch therefore returns to the reported state, and the
 * ventilation can be started again.
 */
export class ActiveVentilationBinding extends ServiceBinding {
  readonly feature = "activeVentilation";
  protected readonly serviceType: ServiceType = this.ctx.hap.Service.Switch;
  protected readonly subtype = "active-ventilation";
  protected readonly displayName = "Ventilation";

  protected override configure(service: Service): void {
    service
      .getCharacteristic(this.ctx.hap.Characteristic.On)
      .onSet(async (value: CharacteristicValue) => {
        const on = value === true;
        await this.command(
          on ? "Start active ventilation" : "Stop active ventilation",
          (client) =>
            on
              ? client.startActiveVentilation()
              : client.stopActiveVentilation(),
        );
        setTimeout(() => {
          this.rerender();
        }, 500).unref();
      });
  }

  protected render(_service: Service, vehicle: Vehicle): void {
    this.set(this.ctx.hap.Characteristic.On, isActiveVentilationOn(vehicle));
  }
}
