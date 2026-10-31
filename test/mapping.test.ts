import { describe, expect, it } from 'vitest';
import type { Vehicle } from '../src/api/types.js';
import {
  batteryValues,
  bodyValues,
  chargingLimit,
  climateValues,
  isActiveVentilationOn,
  isAtHome,
  isAuxiliaryHeatingOn,
  isCharging,
  isPlugConnected,
  normalizeChargingLimit,
  stateOfCharge,
  toCelsius,
} from '../src/vehicle/mapping.js';
import { featureSupport, mergeSnapshot, type VehicleSnapshot } from '../src/vehicle/snapshot.js';
import { loadFixture } from './helpers.js';

const enyaq = loadFixture('enyaq');
const combustion = loadFixture('combustion');

const snapshotOf = (response = enyaq): VehicleSnapshot => mergeSnapshot(undefined, response, 0);

const withCharging = (status: NonNullable<Vehicle['charging']>['status']): Vehicle => ({
  charging: { isVehicleInSavedLocation: false, status },
});

describe('battery mapping', () => {
  it('maps state of charge, charging and low battery', () => {
    expect(batteryValues(enyaq.vehicle, 20)).toEqual({ level: 62, charging: true, low: false });
    expect(batteryValues(enyaq.vehicle, 70)).toMatchObject({ low: true });
  });

  it('is unknown without charging data', () => {
    expect(batteryValues(combustion.vehicle, 20)).toEqual({ level: undefined, charging: undefined, low: undefined });
  });

  it('falls back to the electric engine range of a plug-in hybrid', () => {
    const vehicle: Vehicle = {
      fuelStatus: {
        primaryEngineRange: { engineType: 'GASOLINE', currentFuelLevelInPercent: 40 },
        secondaryEngineRange: { engineType: 'ELECTRIC', currentSoCInPercent: 33.4 },
      },
    };
    expect(stateOfCharge(vehicle)).toBe(33);
  });

  it('clamps out-of-range values', () => {
    expect(stateOfCharge(withCharging({ battery: { stateOfChargeInPercent: 104 } }))).toBe(100);
  });
});

describe('charging outlet mapping', () => {
  it.each([
    ['CHARGING', true],
    ['CONSERVING', false],
    ['READY_FOR_CHARGING', false],
    ['CONNECT_CABLE', false],
    ['CHARGING_INTERRUPTED', false],
    ['SOMETHING_NEW', undefined],
    [undefined, undefined],
  ])('state %s → charging %s', (state, expected) => {
    expect(isCharging(withCharging({ state }))).toBe(expected);
  });

  it('prefers the reported plug state', () => {
    expect(isPlugConnected(withCharging({ plugConnectionState: 'CONNECTED', state: 'CONNECT_CABLE' }))).toBe(true);
    expect(isPlugConnected(withCharging({ plugConnectionState: 'DISCONNECTED' }))).toBe(false);
  });

  it('derives the plug state from the charging state', () => {
    expect(isPlugConnected(withCharging({ state: 'CONNECT_CABLE' }))).toBe(false);
    expect(isPlugConnected(withCharging({ state: 'READY_FOR_CHARGING' }))).toBe(true);
    // Omitted state never means disconnected.
    expect(isPlugConnected(withCharging({}))).toBeUndefined();
  });
});

describe('charging limit mapping', () => {
  it('reads the target state of charge', () => {
    expect(chargingLimit(enyaq.vehicle)).toBe(80);
    expect(chargingLimit(combustion.vehicle)).toBeUndefined();
  });

  it('normalizes to 50–100 in steps of 10', () => {
    expect(normalizeChargingLimit(84)).toBe(80);
    expect(normalizeChargingLimit(85)).toBe(90);
    expect(normalizeChargingLimit(20)).toBe(50);
    expect(normalizeChargingLimit(100)).toBe(100);
  });
});

describe('climate mapping', () => {
  it.each([
    ['OFF', false, 'INACTIVE'],
    ['COMPLETED', false, 'INACTIVE'],
    ['HEATING', true, 'HEATING'],
    ['HEATING_AUXILIARY', true, 'HEATING'],
    ['COOLING', true, 'COOLING'],
    ['VENTILATION', true, 'IDLE'],
    ['UNKNOWN', undefined, undefined],
    ['UNSUPPORTED', undefined, undefined],
  ])('state %s → active %s, mode %s', (state, active, mode) => {
    expect(climateValues({ airConditioning: { state } })).toMatchObject({ active, mode });
  });

  it('reads the target temperature and converts Fahrenheit', () => {
    expect(climateValues(enyaq.vehicle).targetCelsius).toBe(21.5);
    expect(toCelsius({ value: 70, unit: 'FAHRENHEIT' })).toBeCloseTo(21.11, 2);
    expect(toCelsius(undefined)).toBeUndefined();
  });

  it('maps auxiliary heating and active ventilation', () => {
    expect(isAuxiliaryHeatingOn(combustion.vehicle)).toBe(false);
    expect(isAuxiliaryHeatingOn({ auxiliaryHeating: { state: 'HEATING_AUXILIARY' } })).toBe(true);
    expect(isAuxiliaryHeatingOn({ auxiliaryHeating: { state: 'UNKNOWN' } })).toBeUndefined();
    expect(isActiveVentilationOn(enyaq.vehicle)).toBe(false);
    expect(isActiveVentilationOn({ activeVentilation: { state: 'VENTILATION' } })).toBe(true);
  });
});

describe('presence mapping', () => {
  const home = { latitude: 50.4128, longitude: 14.9069, radiusMeters: 150 };

  it('is at home when parked within the radius', () => {
    expect(isAtHome(enyaq.vehicle, home)).toBe(true);
  });

  it('is away when parked outside the radius', () => {
    expect(isAtHome(enyaq.vehicle, { ...home, latitude: 50.5 })).toBe(false);
  });

  it('is away while in motion', () => {
    expect(isAtHome(combustion.vehicle, home)).toBe(false);
  });

  it('is unknown without a position', () => {
    expect(isAtHome({}, home)).toBeUndefined();
    expect(isAtHome({ parkingPosition: { state: 'PARKED' } }, home)).toBeUndefined();
  });
});

describe('body mapping', () => {
  it('maps closed and locked', () => {
    expect(bodyValues(enyaq.vehicle)).toEqual({
      doorsOpen: false,
      windowsOpen: false,
      trunkOpen: false,
      bonnetOpen: false,
      sunroofOpen: undefined,
      locked: true,
    });
  });

  it('maps open and unlocked, with unknown values left out', () => {
    expect(bodyValues(combustion.vehicle)).toEqual({
      doorsOpen: true,
      windowsOpen: undefined,
      trunkOpen: true,
      bonnetOpen: undefined,
      sunroofOpen: true,
      locked: false,
    });
  });

  it('falls back to `locked` when reliableLockStatus is unknown', () => {
    const vehicle = structuredClone(enyaq.vehicle);
    vehicle.status!.overall.reliableLockStatus = 'UNKNOWN';
    vehicle.status!.overall.locked = 'NO';
    expect(bodyValues(vehicle).locked).toBe(false);
  });
});

describe('feature support', () => {
  it('detects what an electric vehicle offers', () => {
    const snapshot = snapshotOf(enyaq);
    expect(featureSupport(snapshot, 'battery')).toBe(true);
    expect(featureSupport(snapshot, 'charging')).toBe(true);
    expect(featureSupport(snapshot, 'chargingLimit')).toBe(true);
    expect(featureSupport(snapshot, 'climate')).toBe(true);
    expect(featureSupport(snapshot, 'auxiliaryHeating')).toBe(false);
    expect(featureSupport(snapshot, 'activeVentilation')).toBe(true);
    expect(featureSupport(snapshot, 'presence')).toBe(true);
    expect(featureSupport(snapshot, 'sunroof')).toBe(false);
    expect(featureSupport(snapshot, 'lock')).toBe(true);
  });

  it('detects what a combustion vehicle offers', () => {
    const snapshot = snapshotOf(combustion);
    expect(featureSupport(snapshot, 'battery')).toBe(false);
    expect(featureSupport(snapshot, 'charging')).toBe(false);
    expect(featureSupport(snapshot, 'auxiliaryHeating')).toBe(true);
    expect(featureSupport(snapshot, 'windows')).toBe(false);
    expect(featureSupport(snapshot, 'sunroof')).toBe(true);
  });

  it('is unknown while parts are unavailable', () => {
    const snapshot = snapshotOf({
      vehicle: { vin: enyaq.vehicle.vin },
      errors: [{ type: 'CHARGING_UNAVAILABLE' }, { type: 'OPERATIONS_UNAVAILABLE' }, { type: 'VEHICLE_STATUS_UNAVAILABLE' }],
    });
    expect(featureSupport(snapshot, 'battery')).toBeUndefined();
    expect(featureSupport(snapshot, 'charging')).toBeUndefined();
    expect(featureSupport(snapshot, 'doors')).toBeUndefined();
  });
});

describe('mergeSnapshot', () => {
  it('keeps temporarily unavailable parts from the previous snapshot', () => {
    const previous = mergeSnapshot(undefined, enyaq, 1);
    const next = mergeSnapshot(
      previous,
      { vehicle: { vin: enyaq.vehicle.vin, odometer: { mileageInKm: 1 } }, errors: [{ type: 'CHARGING_UNAVAILABLE' }] },
      2,
    );
    expect(next.vehicle.charging).toEqual(enyaq.vehicle.charging);
    expect(next.vehicle.odometer).toEqual({ mileageInKm: 1 });
    expect(next.vehicle.status).toBeUndefined();
    expect(next.fetchedAt).toBe(2);
  });
});

describe('anonymized live response of a gasoline vehicle', () => {
  const live = loadFixture('gasoline-live');
  const snapshot = snapshotOf(live);

  it('offers only body sensors, presence and active ventilation', () => {
    const supported = (
      [
        'battery',
        'stateOfChargeSensor',
        'charging',
        'chargingLimit',
        'climate',
        'auxiliaryHeating',
        'activeVentilation',
        'presence',
        'doors',
        'windows',
        'trunk',
        'bonnet',
        'sunroof',
        'lock',
      ] as const
    ).filter((feature) => featureSupport(snapshot, feature));
    expect(supported).toEqual(['activeVentilation', 'presence', 'doors', 'windows', 'trunk', 'bonnet', 'sunroof', 'lock']);
  });

  it('ignores the state of charge the API reports for a gasoline engine', () => {
    // The real API sends currentSoCInPercent: 100 for engineType GASOLINE.
    expect(live.vehicle.fuelStatus?.primaryEngineRange?.currentSoCInPercent).toBe(100);
    expect(stateOfCharge(live.vehicle)).toBeUndefined();
  });

  it('maps the closed and locked body', () => {
    expect(bodyValues(live.vehicle)).toEqual({
      doorsOpen: false,
      windowsOpen: false,
      trunkOpen: false,
      bonnetOpen: false,
      sunroofOpen: false,
      locked: true,
    });
    expect(isActiveVentilationOn(live.vehicle)).toBe(false);
  });
});
