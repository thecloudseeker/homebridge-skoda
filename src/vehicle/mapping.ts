/**
 * Pure mapping from API data to the values HomeKit shows. Every function returns `undefined`
 * for values the API did not report, and callers then keep the previous characteristic value.
 */
import type { HomeLocation } from '../config.js';
import type { ClimateState, TargetTemperature, Vehicle } from '../api/types.js';
import { isWithinRadius } from '../util/geo.js';

/** Charging states other than CHARGING; listed so unknown future values stay "unknown". */
const NOT_CHARGING_STATES = new Set(['CONNECT_CABLE', 'CONSERVING', 'READY_FOR_CHARGING', 'DISCHARGING', 'CHARGING_INTERRUPTED']);

export function stateOfCharge(vehicle: Vehicle): number | undefined {
  const fromCharging = vehicle.charging?.status?.battery?.stateOfChargeInPercent;
  if (fromCharging !== undefined) {
    return clampPercent(fromCharging);
  }
  const ranges = [vehicle.fuelStatus?.primaryEngineRange, vehicle.fuelStatus?.secondaryEngineRange];
  const electric = ranges.find((range) => range?.engineType === 'ELECTRIC')?.currentSoCInPercent;
  return electric === undefined ? undefined : clampPercent(electric);
}

export function isCharging(vehicle: Vehicle): boolean | undefined {
  const state = vehicle.charging?.status?.state;
  if (state === 'CHARGING') {
    return true;
  }
  return state !== undefined && NOT_CHARGING_STATES.has(state) ? false : undefined;
}

export function isPlugConnected(vehicle: Vehicle): boolean | undefined {
  const status = vehicle.charging?.status;
  switch (status?.plugConnectionState) {
    case 'CONNECTED':
      return true;
    case 'DISCONNECTED':
      return false;
  }
  // The API reports a disconnected plug always as CONNECT_CABLE; every other state implies a cable.
  const state = status?.state;
  if (state === 'CONNECT_CABLE') {
    return false;
  }
  return state === 'CHARGING' || (state !== undefined && NOT_CHARGING_STATES.has(state)) ? true : undefined;
}

export interface BatteryValues {
  level: number | undefined;
  charging: boolean | undefined;
  low: boolean | undefined;
}

export function batteryValues(vehicle: Vehicle, lowBatteryThreshold: number): BatteryValues {
  const level = stateOfCharge(vehicle);
  return {
    level,
    charging: isCharging(vehicle),
    low: level === undefined ? undefined : level < lowBatteryThreshold,
  };
}

export function chargingLimit(vehicle: Vehicle): number | undefined {
  return vehicle.charging?.settings?.targetStateOfChargeInPercent;
}

/** Vehicles accept 50–100 % in steps of 10 according to the API reference. */
export function normalizeChargingLimit(percent: number): number {
  return Math.min(100, Math.max(50, Math.round(percent / 10) * 10));
}

export function toCelsius(temperature: TargetTemperature | undefined): number | undefined {
  if (!temperature || !Number.isFinite(temperature.value)) {
    return undefined;
  }
  return temperature.unit === 'FAHRENHEIT' ? ((temperature.value - 32) * 5) / 9 : temperature.value;
}

export type ClimateMode = 'INACTIVE' | 'IDLE' | 'HEATING' | 'COOLING';

export interface ClimateValues {
  active: boolean | undefined;
  mode: ClimateMode | undefined;
  targetCelsius: number | undefined;
}

const CLIMATE_MODES: Partial<Record<ClimateState, ClimateMode>> = {
  OFF: 'INACTIVE',
  COMPLETED: 'INACTIVE',
  VENTILATION: 'IDLE',
  HEATING: 'HEATING',
  HEATING_AUXILIARY: 'HEATING',
  PREHEATING: 'HEATING',
  COOLING: 'COOLING',
};

export function climateValues(vehicle: Vehicle): ClimateValues {
  const ac = vehicle.airConditioning;
  const mode = ac ? CLIMATE_MODES[ac.state] : undefined;
  return {
    active: mode === undefined ? undefined : mode !== 'INACTIVE',
    mode,
    targetCelsius: toCelsius(ac?.targetTemperature),
  };
}

const RUNNING_STATES = new Set(['PREHEATING', 'HEATING', 'HEATING_AUXILIARY', 'VENTILATION']);

function isRunning(state: ClimateState | undefined): boolean | undefined {
  if (state === 'OFF') {
    return false;
  }
  return state !== undefined && RUNNING_STATES.has(state) ? true : undefined;
}

export function isAuxiliaryHeatingOn(vehicle: Vehicle): boolean | undefined {
  return isRunning(vehicle.auxiliaryHeating?.state);
}

export function isActiveVentilationOn(vehicle: Vehicle): boolean | undefined {
  return isRunning(vehicle.activeVentilation?.state);
}

/** "At home": parked within the radius. A vehicle in motion is not at home. */
export function isAtHome(vehicle: Vehicle, home: HomeLocation): boolean | undefined {
  const position = vehicle.parkingPosition;
  if (!position) {
    return undefined;
  }
  if (position.state === 'IN_MOTION') {
    return false;
  }
  if (position.state !== 'PARKED' || !position.gpsCoordinates) {
    return undefined;
  }
  return isWithinRadius(position.gpsCoordinates, home, home.radiusMeters);
}

function isOpen(value: string | undefined): boolean | undefined {
  if (value === 'OPEN') {
    return true;
  }
  return value === 'CLOSED' ? false : undefined;
}

export interface BodyValues {
  doorsOpen: boolean | undefined;
  windowsOpen: boolean | undefined;
  trunkOpen: boolean | undefined;
  bonnetOpen: boolean | undefined;
  sunroofOpen: boolean | undefined;
  locked: boolean | undefined;
}

export function bodyValues(vehicle: Vehicle): BodyValues {
  const overall = vehicle.status?.overall;
  const detail = vehicle.status?.detail;
  return {
    doorsOpen: isOpen(overall?.doors),
    windowsOpen: isOpen(overall?.windows),
    trunkOpen: isOpen(detail?.trunk),
    bonnetOpen: isOpen(detail?.bonnet),
    sunroofOpen: isOpen(detail?.sunroof),
    locked: lockState(vehicle),
  };
}

function lockState(vehicle: Vehicle): boolean | undefined {
  const overall = vehicle.status?.overall;
  // reliableLockStatus reports UNLOCKED only for MOD4 vehicles, so fall back to `locked`.
  switch (overall?.reliableLockStatus) {
    case 'LOCKED':
      return true;
    case 'UNLOCKED':
      return false;
  }
  switch (overall?.locked) {
    case 'YES':
      return true;
    case 'NO':
      return false;
  }
  return undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}
