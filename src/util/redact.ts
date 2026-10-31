/** Shortens a VIN to its last four characters for logs, e.g. `…9999`. */
export function maskVin(vin: string): string {
  return `…${vin.slice(-4)}`;
}

/** Replaces every occurrence of the given secrets (API keys, S-PIN, full VIN) in a log message. */
export function redact(message: string, secrets: readonly (string | undefined)[]): string {
  let result = message;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      result = result.split(secret).join('***');
    }
  }
  return result;
}
