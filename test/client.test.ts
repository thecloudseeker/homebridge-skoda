import { describe, expect, it, vi } from "vitest";
import { SkodaApiClient, parseRetryAfter } from "../src/api/client.js";
import {
  BudgetExhaustedError,
  SkodaApiError,
  SkodaNetworkError,
} from "../src/api/errors.js";
import { RateBudget } from "../src/api/rateBudget.js";
import {
  TEST_TOKEN,
  TEST_VIN,
  loadFixture,
  mockFetch,
  mockResponse,
  problem,
} from "./helpers.js";

function setup(...responses: (Response | Error)[]) {
  const fetch = mockFetch(...responses);
  const budget = new RateBudget({ limit: 20, reserve: 4 });
  const onKeyExpiry = vi.fn();
  const client = new SkodaApiClient({
    token: TEST_TOKEN,
    vin: TEST_VIN,
    budget,
    fetch,
    onKeyExpiry,
  });
  return { client, fetch, budget, onKeyExpiry };
}

function requestOf(fetch: ReturnType<typeof mockFetch>, index = 0) {
  const call = fetch.mock.calls[index];
  if (!call) {
    throw new Error(`fetch call ${index} missing`);
  }
  const [url, init] = call;
  return {
    url: url as string,
    init: init ?? {},
    body: init?.body as string | undefined,
    headers: (init?.headers ?? {}) as Record<string, string>,
  };
}

describe("SkodaApiClient.getVehicle", () => {
  it("requests all parts with the API key header", async () => {
    const fixture = loadFixture("enyaq");
    const { client, fetch } = setup(mockResponse({ body: fixture }));

    await expect(client.getVehicle()).resolves.toEqual(fixture);

    const { url, init, headers } = requestOf(fetch);
    expect(url).toBe(
      `https://public.api.connect.skoda-auto.cz/api/v1/vehicles/${TEST_VIN}` +
        "?include=info,status,fuelStatus,odometer,parkingPosition,airConditioning,auxiliaryHeating,activeVentilation,charging,operations",
    );
    expect(init.method).toBe("GET");
    expect(headers["X-API-Key"]).toBe(TEST_TOKEN);
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("syncs the budget from the RateLimit headers", async () => {
    const { client, budget } = setup(
      mockResponse({
        body: loadFixture("enyaq"),
        headers: {
          "RateLimit-Limit": "20",
          "RateLimit-Remaining": "7",
          "RateLimit-Reset": "1200",
        },
      }),
    );
    await client.getVehicle();
    expect(budget.remaining()).toBe(7);
  });

  it("reports the key expiry", async () => {
    const { client, onKeyExpiry } = setup(
      mockResponse({
        body: loadFixture("enyaq"),
        headers: { "X-API-Key-Expires-At": "2027-01-31T12:00:00Z" },
      }),
    );
    await client.getVehicle();
    expect(onKeyExpiry).toHaveBeenCalledWith(new Date("2027-01-31T12:00:00Z"));
  });

  it("does not send a poll when only the command reserve is left", async () => {
    const { client, fetch, budget } = setup();
    for (let i = 0; i < 16; i++) {
      budget.record();
    }
    await expect(client.getVehicle("poll")).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lets a follow-up refresh use the reserve", async () => {
    const { client, fetch, budget } = setup(
      mockResponse({ body: loadFixture("enyaq") }),
    );
    for (let i = 0; i < 16; i++) {
      budget.record();
    }
    await client.getVehicle("refresh");
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("SkodaApiClient error handling", () => {
  it("maps an expired key to a 401 problem and refunds the slot", async () => {
    const { client, budget } = setup(
      mockResponse({
        status: 401,
        body: problem(401, "api-key-expired", "The API key has expired."),
      }),
    );
    const error = await client.getVehicle().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SkodaApiError);
    expect(error).toMatchObject({
      status: 401,
      problemType: "api-key-expired",
      isAuthError: true,
    });
    expect(budget.remaining()).toBe(20);
  });

  it("maps 422 operation-not-supported and keeps the slot spent", async () => {
    const { client, budget } = setup(
      mockResponse({
        status: 422,
        body: problem(422, "operation-not-supported"),
      }),
    );
    await expect(client.startCharging()).rejects.toMatchObject({
      status: 422,
      problemType: "operation-not-supported",
    });
    expect(budget.remaining()).toBe(19);
  });

  it("blocks the budget on rate-limit-exceeded until Retry-After", async () => {
    const { client, budget } = setup(
      mockResponse({
        status: 429,
        body: problem(429, "rate-limit-exceeded"),
        headers: { "Retry-After": "300" },
      }),
    );
    await expect(client.getVehicle()).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 300,
      isRateLimited: true,
    });
    expect(budget.canSpend("command")).toBe(false);
    expect(budget.nextAvailableAt("command")).toBeGreaterThanOrEqual(
      Date.now() + 299_000,
    );
  });

  it("does not block the budget when the vehicle declines a request", async () => {
    const { client, budget } = setup(
      mockResponse({
        status: 429,
        body: problem(429, "vehicle-not-accepting-requests"),
        headers: { "Retry-After": "60" },
      }),
    );
    await expect(client.startAirConditioning({})).rejects.toMatchObject({
      isRateLimited: false,
    });
    expect(budget.canSpend("command")).toBe(true);
  });

  it("counts 5xx responses against the budget", async () => {
    const { client, budget } = setup(
      mockResponse({
        status: 503,
        body: problem(503),
        headers: { "Retry-After": "30" },
      }),
    );
    await expect(client.getVehicle()).rejects.toMatchObject({
      status: 503,
      problemType: undefined,
      retryAfterSeconds: 30,
    });
    expect(budget.remaining()).toBe(19);
  });

  it("tolerates error responses without a body", async () => {
    const { client } = setup(new Response(null, { status: 504 }));
    await expect(client.getVehicle()).rejects.toMatchObject({
      status: 504,
      problemType: undefined,
    });
  });

  it("wraps network errors without leaking the key", async () => {
    const networkError = new TypeError("fetch failed", {
      cause: { code: "ECONNRESET" },
    });
    const { client } = setup(networkError);
    const error = await client.getVehicle().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SkodaNetworkError);
    expect((error as Error).message).toBe("fetch failed (ECONNRESET)");
    expect(JSON.stringify(error)).not.toContain(TEST_TOKEN);
  });

  it("never puts the key into an API error", async () => {
    const { client } = setup(
      mockResponse({
        status: 403,
        body: problem(403, "api-key-not-authorized"),
      }),
    );
    const error = (await client
      .getVehicle()
      .catch((e: unknown) => e)) as SkodaApiError;
    expect(error.message).not.toContain(TEST_TOKEN);
    expect(JSON.stringify(error)).not.toContain(TEST_TOKEN);
  });
});

describe("SkodaApiClient commands", () => {
  it.each([
    ["startCharging", "POST", "/charging/start"],
    ["stopCharging", "POST", "/charging/stop"],
    ["stopAirConditioning", "POST", "/air-conditioning/stop"],
    ["stopAuxiliaryHeating", "POST", "/auxiliary-heating/stop"],
    ["startActiveVentilation", "POST", "/active-ventilation/start"],
    ["stopActiveVentilation", "POST", "/active-ventilation/stop"],
  ] as const)("%s sends %s %s", async (method, httpMethod, path) => {
    const { client, fetch } = setup(mockResponse({ status: 202 }));
    await client[method]();
    const { url, init } = requestOf(fetch);
    expect(url).toBe(
      `https://public.api.connect.skoda-auto.cz/api/v1/vehicles/${TEST_VIN}${path}`,
    );
    expect(init.method).toBe(httpMethod);
    expect(init.body).toBeUndefined();
  });

  it("sends the charging limit as JSON", async () => {
    const { client, fetch } = setup(mockResponse({ status: 202 }));
    await client.setChargingLimit(80);
    const { url, init, body, headers } = requestOf(fetch);
    expect(url).toMatch(/\/charging\/limit$/);
    expect(init.method).toBe("PUT");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(body!)).toEqual({ targetStateOfChargeInPercent: 80 });
  });

  it("sends the target temperature when starting air conditioning", async () => {
    const { client, fetch } = setup(mockResponse({ status: 202 }));
    await client.startAirConditioning({
      targetTemperature: { value: 21.5, unit: "CELSIUS" },
    });
    expect(JSON.parse(requestOf(fetch).body!)).toEqual({
      targetTemperature: { value: 21.5, unit: "CELSIUS" },
    });
  });

  it("sends the S-PIN when starting auxiliary heating", async () => {
    const { client, fetch } = setup(mockResponse({ status: 202 }));
    await client.startAuxiliaryHeating({
      spin: "0000",
      durationInSeconds: 1800,
    });
    const { url, body } = requestOf(fetch);
    expect(url).toMatch(/\/auxiliary-heating\/start$/);
    expect(JSON.parse(body!)).toEqual({
      spin: "0000",
      durationInSeconds: 1800,
    });
  });

  it("may use the command reserve", async () => {
    const { client, fetch, budget } = setup(mockResponse({ status: 202 }));
    for (let i = 0; i < 19; i++) {
      budget.record();
    }
    await client.startCharging();
    expect(fetch).toHaveBeenCalledOnce();
    await expect(client.stopCharging()).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("120")).toBe(120);
    expect(
      parseRetryAfter(
        "Sat, 31 Oct 2026 12:02:00 GMT",
        Date.parse("2026-10-31T12:00:00Z"),
      ),
    ).toBe(120);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});
