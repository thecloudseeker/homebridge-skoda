import { DEFAULT_COMMAND_RESERVE, DEFAULT_RATE_LIMIT, minimumPollingIntervalMinutes } from './api/rateBudget.js';
import { maskVin } from './util/redact.js';

export interface FeatureToggles {
  /** Battery service (level, charging state, low battery). */
  battery: boolean;
  /** Humidity sensor that mirrors the state of charge, for automations. */
  stateOfChargeSensor: boolean;
  /** Outlet to start and stop charging. */
  charging: boolean;
  /** Lightbulb whose brightness sets the charging limit. */
  chargingLimit: boolean;
  /** Heater cooler for the air conditioning. */
  climate: boolean;
  /** Switch for the auxiliary heating; needs the S-PIN. */
  auxiliaryHeating: boolean;
  /** Switch for the active ventilation. */
  activeVentilation: boolean;
  /** Occupancy sensor "at home"; needs the home coordinates. */
  presence: boolean;
  doors: boolean;
  windows: boolean;
  trunk: boolean;
  bonnet: boolean;
  sunroof: boolean;
  /** Contact sensor that is closed while the vehicle is locked. */
  lock: boolean;
}

export const DEFAULT_FEATURES: Readonly<FeatureToggles> = {
  battery: true,
  stateOfChargeSensor: false,
  charging: true,
  chargingLimit: true,
  climate: true,
  auxiliaryHeating: true,
  activeVentilation: false,
  presence: true,
  doors: true,
  windows: true,
  trunk: true,
  bonnet: true,
  sunroof: true,
  lock: true,
};

export interface HomeLocation {
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

export interface VehicleSettings {
  name: string;
  vin: string;
  token: string;
  /** Separate key for commands; falls back to `token`. */
  commandToken: string | undefined;
  spin: string | undefined;
  home: HomeLocation | undefined;
  pollingIntervalMinutes: number;
  lowBatteryThreshold: number;
  /** Default cabin temperature in °C until the vehicle reports one. */
  climateTemperature: number;
  airConditioningWithoutExternalPower: boolean | undefined;
  auxiliaryHeatingDurationMinutes: number | undefined;
  commandRefreshDelaySeconds: number;
  features: FeatureToggles;
}

export const DEFAULT_POLLING_INTERVAL_MINUTES = 5;
export const MIN_POLLING_INTERVAL_MINUTES = minimumPollingIntervalMinutes(DEFAULT_RATE_LIMIT, DEFAULT_COMMAND_RESERVE);
export const MAX_POLLING_INTERVAL_MINUTES = 24 * 60;
export const DEFAULT_LOW_BATTERY_THRESHOLD = 20;
export const DEFAULT_HOME_RADIUS_METERS = 150;
export const DEFAULT_CLIMATE_TEMPERATURE = 21;
/** Cabin temperature range of the MyŠkoda app; the API documents none. */
export const CLIMATE_TEMPERATURE_MIN = 16;
export const CLIMATE_TEMPERATURE_MAX = 29.5;
export const CLIMATE_TEMPERATURE_STEP = 0.5;
export const DEFAULT_COMMAND_REFRESH_DELAY_SECONDS = 90;

const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

export type ConfigResult =
  | { ok: true; settings: VehicleSettings; warnings: string[] }
  | { ok: false; errors: string[] };

type RawObject = Record<string, unknown>;

const isObject = (value: unknown): value is RawObject => typeof value === 'object' && value !== null && !Array.isArray(value);

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/** Validates and normalizes one entry of the `vehicles` array. Error messages never contain secrets. */
export function parseVehicleConfig(raw: unknown, index: number): ConfigResult {
  const label = `vehicles[${index}]`;
  if (!isObject(raw)) {
    return { ok: false, errors: [`${label} is not an object`] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];

  const vin = optionalString(raw.vin)?.toUpperCase().replace(/\s+/g, '');
  if (!vin) {
    errors.push(`${label}.vin is missing`);
  } else if (!VIN_PATTERN.test(vin)) {
    errors.push(`${label}.vin (${maskVin(vin)}) is not a valid 17-character VIN`);
  }

  const token = optionalString(raw.token);
  if (!token) {
    errors.push(`${label}.token is missing`);
  }

  const home = parseHome(raw.home, `${label}.home`, errors);

  const features: FeatureToggles = { ...DEFAULT_FEATURES };
  if (isObject(raw.features)) {
    for (const key of Object.keys(DEFAULT_FEATURES) as (keyof FeatureToggles)[]) {
      const value = raw.features[key];
      if (typeof value === 'boolean') {
        features[key] = value;
      }
    }
  }

  const spin = optionalString(raw.spin);
  if (features.auxiliaryHeating && !spin) {
    features.auxiliaryHeating = false;
  }
  if (features.presence && !home) {
    features.presence = false;
  }

  let pollingIntervalMinutes = optionalNumber(raw.pollingIntervalMinutes) ?? DEFAULT_POLLING_INTERVAL_MINUTES;
  if (pollingIntervalMinutes < MIN_POLLING_INTERVAL_MINUTES) {
    warnings.push(
      `pollingIntervalMinutes ${pollingIntervalMinutes} is below the minimum of ${MIN_POLLING_INTERVAL_MINUTES} ` +
        `that the rate limit allows; using ${MIN_POLLING_INTERVAL_MINUTES}`,
    );
    pollingIntervalMinutes = MIN_POLLING_INTERVAL_MINUTES;
  }
  pollingIntervalMinutes = Math.min(pollingIntervalMinutes, MAX_POLLING_INTERVAL_MINUTES);

  const climateTemperature = clampTemperature(optionalNumber(raw.climateTemperature) ?? DEFAULT_CLIMATE_TEMPERATURE);
  const lowBatteryThreshold = clamp(optionalNumber(raw.lowBatteryThreshold) ?? DEFAULT_LOW_BATTERY_THRESHOLD, 0, 100);
  const commandRefreshDelaySeconds = clamp(
    optionalNumber(raw.commandRefreshDelaySeconds) ?? DEFAULT_COMMAND_REFRESH_DELAY_SECONDS,
    15,
    600,
  );
  const auxiliaryHeatingDuration = optionalNumber(raw.auxiliaryHeatingDurationMinutes);

  if (errors.length > 0 || !vin || !token) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    warnings,
    settings: {
      name: optionalString(raw.name) ?? `Škoda ${vin.slice(-4)}`,
      vin,
      token,
      commandToken: optionalString(raw.commandToken),
      spin,
      home,
      pollingIntervalMinutes,
      lowBatteryThreshold,
      climateTemperature,
      airConditioningWithoutExternalPower:
        typeof raw.airConditioningWithoutExternalPower === 'boolean' ? raw.airConditioningWithoutExternalPower : undefined,
      auxiliaryHeatingDurationMinutes:
        auxiliaryHeatingDuration === undefined ? undefined : clamp(Math.round(auxiliaryHeatingDuration), 1, 60),
      commandRefreshDelaySeconds,
      features,
    },
  };
}

function parseHome(raw: unknown, label: string, errors: string[]): HomeLocation | undefined {
  if (!isObject(raw)) {
    return undefined;
  }
  const latitude = optionalNumber(raw.lat);
  const longitude = optionalNumber(raw.lon);
  if (latitude === undefined && longitude === undefined) {
    return undefined;
  }
  if (latitude === undefined || latitude < -90 || latitude > 90) {
    errors.push(`${label}.lat must be between -90 and 90`);
    return undefined;
  }
  if (longitude === undefined || longitude < -180 || longitude > 180) {
    errors.push(`${label}.lon must be between -180 and 180`);
    return undefined;
  }
  const radiusMeters = Math.max(10, optionalNumber(raw.radiusMeters) ?? DEFAULT_HOME_RADIUS_METERS);
  return { latitude, longitude, radiusMeters };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampTemperature(celsius: number): number {
  const stepped = Math.round(celsius / CLIMATE_TEMPERATURE_STEP) * CLIMATE_TEMPERATURE_STEP;
  return clamp(stepped, CLIMATE_TEMPERATURE_MIN, CLIMATE_TEMPERATURE_MAX);
}
