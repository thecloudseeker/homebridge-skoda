/**
 * Types for the MyŠkoda Public API (contract 1.1.0), derived from the official OpenAPI document at
 * https://public.api.connect.skoda-auto.cz/v3/api-docs.
 *
 * Enum-like string fields are typed as open unions: the API states that new values may be added
 * over time and clients must tolerate unknown values. Every field is optional unless the contract
 * marks it as required, and a missing field always means "unknown".
 */

type Open<T extends string> = T | (string & {});

export type TemperatureUnit = Open<'CELSIUS' | 'FAHRENHEIT'>;

export interface TargetTemperature {
  value: number;
  unit: TemperatureUnit;
}

export interface OverallVehicleStatus {
  doorsLocked: Open<'YES' | 'NO' | 'OPENED' | 'TRUNK_OPENED' | 'UNKNOWN'>;
  locked: Open<'YES' | 'NO' | 'UNKNOWN'>;
  doors: Open<'OPEN' | 'CLOSED' | 'UNKNOWN'>;
  windows: Open<'OPEN' | 'CLOSED' | 'UNKNOWN' | 'UNSUPPORTED'>;
  lights: Open<'ON' | 'OFF' | 'UNKNOWN'>;
  reliableLockStatus?: Open<'LOCKED' | 'UNLOCKED' | 'UNKNOWN'>;
}

export type OpenClosedState = Open<'OPEN' | 'CLOSED' | 'UNKNOWN' | 'UNSUPPORTED'>;

export interface VehicleStatusDetail {
  sunroof: OpenClosedState;
  trunk: OpenClosedState;
  bonnet: OpenClosedState;
}

export interface VehicleStatus {
  overall: OverallVehicleStatus;
  detail: VehicleStatusDetail;
  carCapturedTimestamp?: string;
}

export interface EngineRange {
  engineType?: Open<'ELECTRIC' | 'GASOLINE' | 'DIESEL' | 'CNG' | 'LPG' | 'UNKNOWN'>;
  currentSoCInPercent?: number;
  currentFuelLevelInPercent?: number;
  remainingRangeInKm?: number;
}

export interface FuelStatus {
  carType?: Open<'HYBRID' | 'GASOLINE' | 'DIESEL' | 'CNG' | 'LPG' | 'UNKNOWN'>;
  adBlueRange?: number;
  totalRangeInKm?: number;
  primaryEngineRange?: EngineRange;
  secondaryEngineRange?: EngineRange;
  carCapturedTimestamp?: string;
}

export interface Odometer {
  mileageInKm: number;
  carCapturedTimestamp?: string;
}

export interface ParkingPosition {
  state: Open<'IN_MOTION' | 'PARKED'>;
  gpsCoordinates?: { latitude: number; longitude: number };
  formattedAddress?: string;
}

export type ClimateState = Open<
  | 'OFF'
  | 'COOLING'
  | 'HEATING'
  | 'HEATING_AUXILIARY'
  | 'VENTILATION'
  | 'COMPLETED'
  | 'PREHEATING'
  | 'UNKNOWN'
  | 'UNSUPPORTED'
>;

export interface WindowHeating {
  enabled?: boolean;
  front?: Open<'ON' | 'OFF' | 'UNKNOWN' | 'UNSUPPORTED'>;
  rear?: Open<'ON' | 'OFF' | 'UNKNOWN' | 'UNSUPPORTED'>;
}

export interface AirConditioning {
  state: ClimateState;
  targetTemperature?: TargetTemperature;
  estimatedReachOfTargetTemperatureAt?: string;
  airConditioningWithoutExternalPower?: boolean;
  airConditioningAtUnlock?: boolean;
  windowHeating?: WindowHeating;
  carCapturedTimestamp?: string;
}

export interface AuxiliaryHeating {
  state: ClimateState;
  startMode?: Open<'HEATING' | 'VENTILATION'>;
  durationInSeconds?: number;
  targetTemperature?: TargetTemperature;
  estimatedReachOfTargetTemperatureAt?: string;
  carCapturedTimestamp?: string;
}

export interface ActiveVentilation {
  state: ClimateState;
  durationInSeconds?: number;
  carCapturedTimestamp?: string;
}

export type ChargingState = Open<
  'CONNECT_CABLE' | 'CHARGING' | 'CONSERVING' | 'READY_FOR_CHARGING' | 'DISCHARGING' | 'CHARGING_INTERRUPTED'
>;

export interface BatteryStatus {
  remainingCruisingRangeInMeters?: number;
  stateOfChargeInPercent?: number;
}

export interface ChargingStatus {
  chargingRateInKilometersPerHour?: number;
  chargePowerInKw?: number;
  remainingTimeToFullyChargedInMinutes?: number;
  fullyChargedAt?: string;
  state?: ChargingState;
  chargeType?: Open<'AC' | 'DC' | 'OFF'>;
  plugConnectionState?: Open<'CONNECTED' | 'DISCONNECTED'>;
  plugLockState?: Open<'LOCKED' | 'UNLOCKED'>;
  battery?: BatteryStatus;
}

export interface ChargingSettings {
  targetStateOfChargeInPercent?: number;
  batteryCareModeTargetValueInPercent?: number;
  preferredChargeMode?: string;
  availableChargeModes?: string[];
  chargingCareMode?: string;
  autoUnlockPlugWhenCharged?: string;
  maxChargeCurrentAc?: string;
  maxChargeCurrentAcAmpere?: number;
}

export interface Charging {
  isVehicleInSavedLocation: boolean;
  status?: ChargingStatus;
  settings?: ChargingSettings;
  carCapturedTimestamp?: string;
}

export type OperationName = Open<
  | 'startCharging'
  | 'stopCharging'
  | 'setChargingLimit'
  | 'setChargeMode'
  | 'updateChargingProfile'
  | 'startAirConditioning'
  | 'stopAirConditioning'
  | 'startAuxiliaryHeating'
  | 'stopAuxiliaryHeating'
  | 'startActiveVentilation'
  | 'stopActiveVentilation'
>;

export interface VehicleOperation {
  name: OperationName;
}

export interface Vehicle {
  vin?: string;
  name?: string;
  licensePlate?: string;
  renderUrl?: string;
  status?: VehicleStatus;
  fuelStatus?: FuelStatus;
  odometer?: Odometer;
  parkingPosition?: ParkingPosition;
  airConditioning?: AirConditioning;
  auxiliaryHeating?: AuxiliaryHeating;
  activeVentilation?: ActiveVentilation;
  charging?: Charging;
  /** Charging profiles are not used by the plugin, so they are kept untyped. */
  chargingProfiles?: unknown;
  operations?: VehicleOperation[];
}

/** e.g. `CHARGING_UNSUPPORTED`, `PARKING_POSITION_UNAVAILABLE`, `OPERATIONS_UNAVAILABLE`. */
export interface VehicleError {
  type: string;
  description?: string;
}

export interface VehicleResponse {
  vehicle: Vehicle;
  errors?: VehicleError[];
}

/** Values of the `include` query parameter of `GET /api/v1/vehicles/{vin}`. */
export const VEHICLE_PARTS = [
  'info',
  'status',
  'fuelStatus',
  'odometer',
  'parkingPosition',
  'airConditioning',
  'auxiliaryHeating',
  'activeVentilation',
  'charging',
  'operations',
] as const;

export type VehiclePart = (typeof VEHICLE_PARTS)[number];

export interface StartAirConditioningConfiguration {
  targetTemperature?: TargetTemperature;
  airConditioningWithoutExternalPower?: boolean;
}

export interface StartAuxiliaryHeatingConfiguration {
  spin: string;
  targetTemperature?: TargetTemperature;
  durationInSeconds?: number;
  startMode?: 'HEATING' | 'VENTILATION';
}

/** RFC 9457 problem details. */
export interface ProblemDetail {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  parameter?: string;
  rejectedValue?: unknown;
  allowedValues?: unknown;
}
