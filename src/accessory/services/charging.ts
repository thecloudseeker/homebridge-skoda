import type { CharacteristicValue, Service } from 'homebridge';
import type { Vehicle } from '../../api/types.js';
import { chargingLimit, isCharging, isPlugConnected, normalizeChargingLimit } from '../../vehicle/mapping.js';
import { ServiceBinding, debounce, patchChargingStatus, type ServiceType } from './common.js';

const SLIDER_DEBOUNCE_MS = 3000;

/** Outlet: On starts and stops charging, OutletInUse shows whether the cable is plugged in. */
export class ChargingBinding extends ServiceBinding {
  readonly feature = 'charging';
  protected readonly serviceType: ServiceType = this.ctx.hap.Service.Outlet;
  protected readonly subtype = 'charging';
  protected readonly displayName = 'Charging';

  protected override configure(service: Service): void {
    service.getCharacteristic(this.ctx.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {
      if (value === true) {
        await this.command(
          'Start charging',
          (client) => client.startCharging(),
          (vehicle) => {
            patchChargingStatus(vehicle, { state: 'CHARGING' });
          },
        );
      } else {
        await this.command(
          'Stop charging',
          (client) => client.stopCharging(),
          (vehicle) => {
            patchChargingStatus(vehicle, { state: 'READY_FOR_CHARGING', chargePowerInKw: 0 });
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

/**
 * Lightbulb whose brightness is the charging limit. HomeKit has no better fitting control for a
 * percentage setpoint. Values snap to 50–100 % in steps of 10, as the vehicles require; the bulb
 * cannot be switched off.
 */
export class ChargingLimitBinding extends ServiceBinding {
  readonly feature = 'chargingLimit';
  protected readonly serviceType: ServiceType = this.ctx.hap.Service.Lightbulb;
  protected readonly subtype = 'charging-limit';
  protected readonly displayName = 'Charge Limit';

  private readonly sendLimit = debounce(SLIDER_DEBOUNCE_MS, (percent: number) => {
    this.command(
      `Set charging limit to ${percent} %`,
      (client) => client.setChargingLimit(percent),
      (vehicle) => {
        vehicle.charging ??= { isVehicleInSavedLocation: false };
        vehicle.charging.settings = { ...vehicle.charging.settings, targetStateOfChargeInPercent: percent };
      },
    ).catch(() => {
      // Already logged and reverted.
    });
  });

  protected override configure(service: Service): void {
    const { On, Brightness } = this.ctx.hap.Characteristic;
    service.getCharacteristic(Brightness).setProps({ minStep: 10 });
    service.getCharacteristic(On).onSet((value: CharacteristicValue) => {
      if (value !== true) {
        setTimeout(() => service.updateCharacteristic(On, true), 500).unref();
      }
    });
    service.getCharacteristic(Brightness).onSet((value: CharacteristicValue) => {
      const percent = normalizeChargingLimit(Number(value));
      if (percent !== value) {
        setTimeout(() => service.updateCharacteristic(Brightness, percent), 500).unref();
      }
      this.sendLimit(percent);
    });
  }

  protected render(_service: Service, vehicle: Vehicle): void {
    const { On, Brightness } = this.ctx.hap.Characteristic;
    this.set(On, true);
    this.set(Brightness, chargingLimit(vehicle));
  }
}
