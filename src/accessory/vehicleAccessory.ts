import { maskVin } from '../util/redact.js';
import { PLUGIN_VERSION } from '../settings.js';
import { featureSupport, type VehicleSnapshot } from '../vehicle/snapshot.js';
import { BatteryBinding, StateOfChargeSensorBinding } from './services/battery.js';
import { PresenceBinding, contactBindings } from './services/body.js';
import { ChargingBinding, ChargingLimitBinding } from './services/charging.js';
import { ActiveVentilationBinding, AuxiliaryHeatingBinding, ClimateBinding } from './services/climate.js';
import type { BindingContext, ServiceBinding } from './services/common.js';

/**
 * One HomeKit accessory per vehicle. Services are created only for features that are enabled in
 * the config and that the vehicle reports as supported, and removed when the vehicle explicitly
 * reports them unsupported. While support is unknown (e.g. the API is unreachable), cached
 * services are kept as they are.
 */
export class VehicleAccessory {
  private readonly bindings: ServiceBinding[];

  constructor(private readonly ctx: BindingContext) {
    this.bindings = [
      new BatteryBinding(ctx),
      new StateOfChargeSensorBinding(ctx),
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
      ?.setCharacteristic(Characteristic.Manufacturer, 'Škoda')
      .setCharacteristic(Characteristic.Model, 'MyŠkoda vehicle')
      .setCharacteristic(Characteristic.SerialNumber, maskVin(ctx.settings.vin))
      .setCharacteristic(Characteristic.FirmwareRevision, PLUGIN_VERSION);

    this.sync(ctx.controller.snapshot);
    ctx.controller.onUpdate((snapshot) => {
      this.sync(snapshot);
    });
  }

  private sync(snapshot: VehicleSnapshot | undefined): void {
    const stale = this.ctx.controller.isStale();
    for (const binding of this.bindings) {
      const enabled = this.ctx.settings.features[binding.feature];
      const supported = snapshot ? featureSupport(snapshot, binding.feature) : undefined;
      if (!enabled || supported === false) {
        binding.detach();
        continue;
      }
      if (supported === true || binding.exists()) {
        binding.attach();
        binding.update(snapshot, stale);
      }
    }
  }
}
