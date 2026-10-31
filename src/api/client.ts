import { BudgetExhaustedError, SkodaApiError, SkodaNetworkError, parseProblemType } from './errors.js';
import type { RateBudget, RateLimitHeaders, RequestKind } from './rateBudget.js';
import {
  VEHICLE_PARTS,
  type ProblemDetail,
  type StartAirConditioningConfiguration,
  type StartAuxiliaryHeatingConfiguration,
  type VehiclePart,
  type VehicleResponse,
} from './types.js';

export const DEFAULT_BASE_URL = 'https://public.api.connect.skoda-auto.cz';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface SkodaApiClientOptions {
  token: string;
  vin: string;
  /** Shared by all clients of the same vehicle, because the rate limit applies per VIN. */
  budget: RateBudget;
  baseUrl?: string;
  timeoutMs?: number;
  userAgent?: string;
  fetch?: typeof fetch;
  /** Called with the value of `X-API-Key-Expires-At` after every successful response. */
  onKeyExpiry?: (expiresAt: Date) => void;
}

/**
 * Thin client for the MyŠkoda Public API. Every request goes through the shared rate budget;
 * when the budget has no slot left, the request is not sent and a {@link BudgetExhaustedError}
 * is thrown instead.
 */
export class SkodaApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SkodaApiClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** `GET /api/v1/vehicles/{vin}` with an explicit `include`, so unsupported parts are reported as errors. */
  async getVehicle(kind: 'poll' | 'refresh' = 'poll', parts: readonly VehiclePart[] = VEHICLE_PARTS): Promise<VehicleResponse> {
    const query = `?include=${parts.map(encodeURIComponent).join(',')}`;
    const response = await this.request('GET', '', kind, undefined, query);
    return (await response.json()) as VehicleResponse;
  }

  startCharging(): Promise<void> {
    return this.command('POST', '/charging/start');
  }

  stopCharging(): Promise<void> {
    return this.command('POST', '/charging/stop');
  }

  setChargingLimit(targetStateOfChargeInPercent: number): Promise<void> {
    return this.command('PUT', '/charging/limit', { targetStateOfChargeInPercent });
  }

  startAirConditioning(configuration: StartAirConditioningConfiguration): Promise<void> {
    return this.command('POST', '/air-conditioning/start', configuration);
  }

  stopAirConditioning(): Promise<void> {
    return this.command('POST', '/air-conditioning/stop');
  }

  startAuxiliaryHeating(configuration: StartAuxiliaryHeatingConfiguration): Promise<void> {
    return this.command('POST', '/auxiliary-heating/start', configuration);
  }

  stopAuxiliaryHeating(): Promise<void> {
    return this.command('POST', '/auxiliary-heating/stop');
  }

  startActiveVentilation(): Promise<void> {
    return this.command('POST', '/active-ventilation/start');
  }

  stopActiveVentilation(): Promise<void> {
    return this.command('POST', '/active-ventilation/stop');
  }

  private async command(method: 'POST' | 'PUT', path: string, body?: object): Promise<void> {
    const response = await this.request(method, path, 'command', body);
    // Commands answer 202 without a body; drain it anyway so the connection can be reused.
    await response.body?.cancel();
  }

  private async request(
    method: string,
    path: string,
    kind: RequestKind,
    body?: object,
    query = '',
  ): Promise<Response> {
    const { budget } = this.options;
    if (!budget.canSpend(kind)) {
      throw new BudgetExhaustedError(budget.nextAvailableAt(kind));
    }

    const url = `${this.baseUrl}/api/v1/vehicles/${encodeURIComponent(this.options.vin)}${path}${query}`;
    const headers: Record<string, string> = {
      'X-API-Key': this.options.token,
      Accept: 'application/json, application/problem+json',
    };
    if (this.options.userAgent) {
      headers['User-Agent'] = this.options.userAgent;
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    budget.record();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      // Whether the request reached the server is unknown, so the slot stays spent.
      throw new SkodaNetworkError(describeNetworkError(error));
    }

    budget.updateFromHeaders(readRateLimitHeaders(response.headers));

    if (response.ok) {
      const expiresAt = parseDate(response.headers.get('X-API-Key-Expires-At'));
      if (expiresAt) {
        this.options.onKeyExpiry?.(expiresAt);
      }
      return response;
    }

    const retryAfterSeconds = parseRetryAfter(response.headers.get('Retry-After'));
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      // Documented: these responses do not consume quota.
      budget.refund();
    }
    const problem = await readProblem(response);
    const problemType = parseProblemType(problem?.type);
    if (response.status === 429 && problemType !== 'vehicle-not-accepting-requests') {
      budget.blockUntil(Date.now() + (retryAfterSeconds ?? 60) * 1000);
    }
    throw new SkodaApiError(response.status, problemType, problem?.detail, retryAfterSeconds, problem);
  }
}

function readRateLimitHeaders(headers: Headers): RateLimitHeaders {
  return {
    limit: parseInteger(headers.get('RateLimit-Limit')),
    remaining: parseInteger(headers.get('RateLimit-Remaining')),
    resetSeconds: parseInteger(headers.get('RateLimit-Reset')),
  };
}

async function readProblem(response: Response): Promise<ProblemDetail | undefined> {
  try {
    const text = await response.text();
    if (!text) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseInteger(value: string | null): number | undefined {
  if (value === null || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
}

/** `Retry-After` is either delay-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  const seconds = parseInteger(value);
  if (seconds !== undefined) {
    return Math.max(0, seconds);
  }
  const date = parseDate(value);
  return date ? Math.max(0, Math.ceil((date.getTime() - now) / 1000)) : undefined;
}

function parseDate(value: string | null): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return 'request timed out';
    }
    const cause = (error as { cause?: { code?: unknown } }).cause;
    return typeof cause?.code === 'string' ? `${error.message} (${cause.code})` : error.message;
  }
  return 'unknown network error';
}
