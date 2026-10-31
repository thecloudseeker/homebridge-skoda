import { maskVin, redact } from './redact.js';

/** The subset of the Homebridge logger the plugin uses. */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Prefixes every message with the vehicle name and the masked VIN, and scrubs the API keys,
 * the S-PIN and the full VIN from the message as a last line of defence.
 */
export function createVehicleLogger(
  log: Logger,
  vehicleName: string,
  vin: string,
  secrets: readonly (string | undefined)[],
): Logger {
  const prefix = `[${vehicleName} ${maskVin(vin)}]`;
  const all = [...secrets, vin];
  const format = (message: string) => `${prefix} ${redact(message, all)}`;
  return {
    debug: (message) => {
      log.debug(format(message));
    },
    info: (message) => {
      log.info(format(message));
    },
    warn: (message) => {
      log.warn(format(message));
    },
    error: (message) => {
      log.error(format(message));
    },
  };
}
