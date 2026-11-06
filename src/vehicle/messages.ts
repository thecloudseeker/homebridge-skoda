import { BudgetExhaustedError, SkodaApiError } from "../api/errors.js";

const MINUTE = 60_000;

/** What to do about an error that does not fix itself: an invalid key, a missing vehicle. */
export function describeConfigError(error: SkodaApiError): string {
  switch (error.problemType) {
    case "api-key-expired":
      return "The API key has expired. Create or update a key in the MyŠkoda app and update the plugin config.";
    case "api-key-not-authorized":
      return "The API key does not cover this vehicle or operation. Check the key and the VIN in the plugin config.";
    case "operation-not-authorized":
      return "The vehicle refused the request for the user the API key belongs to.";
  }
  switch (error.status) {
    case 401:
      // Observed for unknown or deleted keys: `about:blank` with "Missing or invalid API key."
      return "The API key is invalid or no longer exists. Check the key in the plugin config or create a new one in the MyŠkoda app.";
    case 404:
      return "No vehicle found for the configured VIN.";
  }
  return `Access denied (${error.message}).`;
}

/** A short reason for a failed command, for the log. */
export function describeCommandError(error: unknown): string {
  if (error instanceof BudgetExhaustedError) {
    return `rate limit budget exhausted until ${new Date(error.availableAt).toLocaleTimeString()}`;
  }
  if (error instanceof SkodaApiError) {
    switch (error.problemType) {
      case "operation-not-supported":
        return "the vehicle does not support this operation";
      case "operation-disabled":
        return "this function is currently disabled for the vehicle";
      case "vehicle-not-accepting-requests":
        return "the vehicle declined the request, e.g. because its 12 V battery is low; try again later";
      case "rate-limit-exceeded":
        return "rate limit exceeded";
      case "api-key-expired":
      case "api-key-not-authorized":
      case "operation-not-authorized":
        return describeConfigError(error);
    }
    return error.isAuthError || error.status === 404
      ? describeConfigError(error)
      : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** A delay for the log, in minutes from one minute on. */
export function formatDelay(ms: number): string {
  return ms >= MINUTE
    ? `${Math.round(ms / MINUTE)} min`
    : `${Math.round(ms / 1000)} s`;
}
