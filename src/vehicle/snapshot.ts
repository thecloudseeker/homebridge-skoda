import type { FeatureToggles } from '../config.js';
import type { OperationName, Vehicle, VehicleError, VehicleResponse } from '../api/types.js';

/** The cached state of one vehicle, as served to HomeKit. */
export interface VehicleSnapshot {
  vehicle: Vehicle;
  errors: VehicleError[];
  /** When the data was fetched from the API (not when the car captured it). */
  fetchedAt: number;
}

type PartKey = Exclude<keyof Vehicle, 'vin' | 'name' | 'licensePlate' | 'renderUrl'>;

/** Prefix of the `errors[].type` codes that describe each part. */
const ERROR_PREFIX: Record<PartKey, string> = {
  status: 'VEHICLE_STATUS',
  fuelStatus: 'FUEL_STATUS',
  odometer: 'ODOMETER',
  parkingPosition: 'PARKING_POSITION',
  airConditioning: 'AIR_CONDITIONING',
  auxiliaryHeating: 'AUXILIARY_HEATING',
  activeVentilation: 'ACTIVE_VENTILATION',
  charging: 'CHARGING',
  chargingProfiles: 'CHARGING_PROFILES',
  operations: 'OPERATIONS',
};

const PART_KEYS = Object.keys(ERROR_PREFIX) as PartKey[];

const hasError = (errors: readonly VehicleError[], type: string) => errors.some((error) => error.type === type);

/**
 * Builds the new snapshot from a response. Parts that are only temporarily unavailable
 * (`*_UNAVAILABLE`) keep their previous value, so HomeKit does not flap between states.
 */
export function mergeSnapshot(previous: VehicleSnapshot | undefined, response: VehicleResponse, now: number): VehicleSnapshot {
  const errors = response.errors ?? [];
  const vehicle: Vehicle = { ...response.vehicle };
  if (previous) {
    for (const key of PART_KEYS) {
      if (vehicle[key] === undefined && hasError(errors, `${ERROR_PREFIX[key]}_UNAVAILABLE`)) {
        Object.assign(vehicle, { [key]: previous.vehicle[key] });
      }
    }
  }
  return { vehicle, errors, fetchedAt: now };
}

/** `true` when the part is present, `false` when the API reports it unsupported, otherwise unknown. */
export function partSupport(snapshot: VehicleSnapshot, key: PartKey): boolean | undefined {
  if (snapshot.vehicle[key] !== undefined) {
    return true;
  }
  return hasError(snapshot.errors, `${ERROR_PREFIX[key]}_UNSUPPORTED`) ? false : undefined;
}

/** Whether the vehicle supports all of the given operations; unknown when `operations` is missing. */
export function operationSupport(snapshot: VehicleSnapshot, ...names: OperationName[]): boolean | undefined {
  const operations = snapshot.vehicle.operations;
  if (!operations) {
    return undefined;
  }
  return names.every((name) => operations.some((operation) => operation.name === name));
}

function statusFieldSupport(snapshot: VehicleSnapshot, read: (vehicle: Vehicle) => string | undefined): boolean | undefined {
  const support = partSupport(snapshot, 'status');
  if (support !== true) {
    return support;
  }
  const value = read(snapshot.vehicle);
  return value !== undefined && value !== 'UNSUPPORTED';
}

/**
 * Whether the vehicle supports a feature. `undefined` means "cannot tell right now"; callers keep
 * whatever they had, so a transient outage never removes services from HomeKit.
 */
export function featureSupport(snapshot: VehicleSnapshot, feature: keyof FeatureToggles): boolean | undefined {
  switch (feature) {
    case 'battery':
    case 'stateOfChargeSensor':
      return partSupport(snapshot, 'charging');
    case 'charging':
      return operationSupport(snapshot, 'startCharging', 'stopCharging');
    case 'chargingLimit':
      return operationSupport(snapshot, 'setChargingLimit');
    case 'climate':
      return operationSupport(snapshot, 'startAirConditioning', 'stopAirConditioning');
    case 'auxiliaryHeating':
      return operationSupport(snapshot, 'startAuxiliaryHeating', 'stopAuxiliaryHeating');
    case 'activeVentilation':
      return operationSupport(snapshot, 'startActiveVentilation', 'stopActiveVentilation');
    case 'presence':
      return partSupport(snapshot, 'parkingPosition');
    case 'doors':
      return statusFieldSupport(snapshot, (v) => v.status?.overall.doors);
    case 'windows':
      return statusFieldSupport(snapshot, (v) => v.status?.overall.windows);
    case 'trunk':
      return statusFieldSupport(snapshot, (v) => v.status?.detail.trunk);
    case 'bonnet':
      return statusFieldSupport(snapshot, (v) => v.status?.detail.bonnet);
    case 'sunroof':
      return statusFieldSupport(snapshot, (v) => v.status?.detail.sunroof);
    case 'lock':
      return statusFieldSupport(snapshot, (v) => v.status?.overall.reliableLockStatus ?? v.status?.overall.locked);
  }
}
