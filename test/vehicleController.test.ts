import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkodaApiClient } from "../src/api/client.js";
import { SkodaApiError } from "../src/api/errors.js";
import { RateBudget } from "../src/api/rateBudget.js";
import type { Vehicle } from "../src/api/types.js";
import { VehicleController } from "../src/vehicle/vehicleController.js";
import {
  TEST_COMMAND_TOKEN,
  TEST_TOKEN,
  TEST_VIN,
  loadFixture,
  mockFetch,
  mockResponse,
  problem,
  silentLogger,
} from "./helpers.js";

const MINUTE = 60_000;

const invalidKeyError = () =>
  new SkodaApiError(401, undefined, "Missing or invalid API key.", undefined);

/** A fetch mock that serves the vehicle fixture for GET and 202 for commands, unless overridden. */
function routedFetch(overrides: (Response | Error)[] = []) {
  const queue = [...overrides];
  return vi.fn<typeof fetch>((_url, init) => {
    const next = queue.shift();
    if (next) {
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    }
    return Promise.resolve(
      init?.method === "GET"
        ? mockResponse({ body: loadFixture("enyaq") })
        : mockResponse({ status: 202 }),
    );
  });
}

function setup(
  fetch: typeof globalThis.fetch = routedFetch(),
  options: { separateCommandKey?: boolean; refreshDelaySeconds?: number } = {},
) {
  const budget = new RateBudget();
  const log = silentLogger();
  const pollClient = new SkodaApiClient({
    token: TEST_TOKEN,
    vin: TEST_VIN,
    budget,
    fetch,
  });
  const commandClient = options.separateCommandKey
    ? new SkodaApiClient({
        token: TEST_COMMAND_TOKEN,
        vin: TEST_VIN,
        budget,
        fetch,
      })
    : pollClient;
  const controller = new VehicleController({
    pollClient,
    commandClient,
    log,
    pollingIntervalMinutes: 5,
    commandRefreshDelaySeconds: options.refreshDelaySeconds ?? 0,
  });
  const updates = vi.fn();
  controller.onUpdate(updates);
  return { controller, budget, log, updates };
}

/** The Enyaq fixture with the charging part as the vehicle reported it at `capturedAt`. */
function enyaqCharging(state: string, capturedAt: string) {
  const body = loadFixture("enyaq");
  body.vehicle.charging!.status!.state = state;
  body.vehicle.charging!.carCapturedTimestamp = capturedAt;
  return mockResponse({ body });
}

const stopChargingPatch = {
  part: "charging" as const,
  apply: (vehicle: Vehicle) => {
    vehicle.charging!.status!.state = "READY_FOR_CHARGING";
  },
};

const methods = (fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>) =>
  fetch.mock.calls.map(
    ([url, init]) =>
      `${init?.method ?? ""} ${(url as string).replace(/^.*\/vehicles\/[^/?]+/, "")}`,
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("VehicleController polling", () => {
  it("polls immediately and then every interval", async () => {
    const fetch = routedFetch();
    const { controller, updates } = setup(fetch);
    expect(controller.isStale()).toBe(true);

    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(controller.snapshot?.vehicle.name).toBe("My Enyaq");
    expect(controller.isStale()).toBe(false);
    expect(updates).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(fetch).toHaveBeenCalledTimes(14);
    controller.stop();
  });

  it("never exceeds 20 requests per hour, even with many commands", async () => {
    const sentAt: number[] = [];
    const inner = routedFetch();
    const fetch = vi.fn<typeof globalThis.fetch>((url, init) => {
      sentAt.push(Date.now());
      return inner(url, init);
    });
    const { controller } = setup(fetch);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    // A command every two minutes for three hours, each scheduling its own refresh.
    for (let i = 0; i < 90; i++) {
      await controller
        .runCommand("Start charging", (client) => client.startCharging())
        .catch(() => undefined);
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
    }
    controller.stop();

    expect(sentAt.length).toBeGreaterThan(40);
    for (const start of sentAt) {
      const inWindow = sentAt.filter(
        (t) => t >= start && t < start + 60 * MINUTE,
      ).length;
      expect(inWindow).toBeLessThanOrEqual(20);
    }
  });

  it("backs off exponentially on server errors", async () => {
    const fetch = routedFetch([
      mockResponse({ status: 500, body: problem(500) }),
      mockResponse({ status: 502, body: problem(502) }),
      mockResponse({ status: 504, body: problem(504) }),
    ]);
    const { controller, log } = setup(fetch);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * MINUTE); // 1st retry after one interval
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MINUTE); // 2nd retry after 10 minutes
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20 * MINUTE); // 3rd retry after 20 minutes succeeds
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(controller.snapshot).toBeDefined();
    expect(log.warn).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledWith(
      "Connection to the MyŠkoda API restored",
    );
    controller.stop();
  });

  it("honours Retry-After on 429", async () => {
    const fetch = routedFetch([
      mockResponse({
        status: 429,
        body: problem(429, "rate-limit-exceeded"),
        headers: { "Retry-After": "1200" },
      }),
    ]);
    const { controller } = setup(fetch);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(19 * MINUTE);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(fetch).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it("logs an expired key once and retries hourly", async () => {
    const expired = () =>
      mockResponse({ status: 401, body: problem(401, "api-key-expired") });
    const fetch = routedFetch([expired(), expired(), expired()]);
    const { controller, log } = setup(fetch);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2 * 60 * MINUTE);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]?.[0]).toContain("API key has expired");
    controller.stop();
  });

  it("explains an invalid key", async () => {
    // Shape of the real response for an unknown or deleted key.
    const invalid = mockResponse({
      status: 401,
      body: {
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        detail: "Missing or invalid API key.",
      },
    });
    const { controller, log } = setup(routedFetch([invalid]));
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("The API key is invalid or no longer exists"),
    );
    await expect(
      controller.runCommand("Start charging", () =>
        Promise.reject(invalidKeyError()),
      ),
    ).rejects.toBeDefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Start charging failed: The API key is invalid"),
    );
    controller.stop();
  });

  it("survives network errors", async () => {
    const fetch = routedFetch([new TypeError("fetch failed")]);
    const { controller, log, updates } = setup(fetch);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("fetch failed"),
    );
    expect(updates).toHaveBeenCalledWith(undefined);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(controller.snapshot).toBeDefined();
    controller.stop();
  });

  it("turns stale after three missed intervals and notifies listeners", async () => {
    const fetch = routedFetch([
      mockResponse({ body: loadFixture("enyaq") }),
      ...Array.from({ length: 5 }, () => new TypeError("fetch failed")),
    ]);
    const { controller, updates } = setup(fetch);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.isStale()).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * MINUTE + 10 * MINUTE);
    expect(controller.isStale()).toBe(false);
    updates.mockClear();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(controller.isStale()).toBe(true);
    expect(updates).toHaveBeenCalled();
    controller.stop();
  });
});

describe("VehicleController commands", () => {
  it("keeps the optimistic state until the vehicle reports again, without an extra request", async () => {
    const fetch = routedFetch([
      mockResponse({ body: loadFixture("enyaq") }),
      mockResponse({ status: 202 }),
      // Next poll: the vehicle has not reported the charging part since the command.
      mockResponse({ body: loadFixture("enyaq") }),
      // The poll after that carries a report captured after the command.
      enyaqCharging("CHARGING", "2026-10-31T12:06:00Z"),
    ]);
    const { controller } = setup(fetch);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);

    await controller.runCommand("Stop charging", (c) => c.stopCharging(), {
      optimistic: stopChargingPatch,
    });
    const state = () => controller.snapshot?.vehicle.charging?.status?.state;
    expect(state()).toBe("READY_FOR_CHARGING");

    await vi.advanceTimersByTimeAsync(5 * MINUTE - 1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(state()).toBe("READY_FOR_CHARGING");

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(fetch).toHaveBeenCalledTimes(4);
    // The vehicle's own report wins, even when it differs from the expected state.
    expect(state()).toBe("CHARGING");
    controller.stop();
  });

  it("ignores a report captured before the command", async () => {
    const fetch = routedFetch([
      mockResponse({ body: loadFixture("enyaq") }),
      mockResponse({ status: 202 }),
      enyaqCharging("CHARGING", "2026-10-31T11:59:00Z"),
    ]);
    const { controller } = setup(fetch);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    await controller.runCommand("Stop charging", (c) => c.stopCharging(), {
      optimistic: stopChargingPatch,
    });
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(controller.snapshot?.vehicle.charging?.status?.state).toBe(
      "READY_FOR_CHARGING",
    );
    controller.stop();
  });

  it("drops the optimistic state after 15 minutes without a report", async () => {
    const { controller } = setup();
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    await controller.runCommand("Stop charging", (c) => c.stopCharging(), {
      optimistic: stopChargingPatch,
    });
    const state = () => controller.snapshot?.vehicle.charging?.status?.state;
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(state()).toBe("READY_FOR_CHARGING");
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(state()).toBe("CHARGING");
    controller.stop();
  });

  it("refreshes once after the delay when a refresh delay is configured", async () => {
    const fetch = routedFetch();
    const { controller } = setup(fetch, { refreshDelaySeconds: 90 });
    controller.start();
    await vi.advanceTimersByTimeAsync(0);

    await controller.runCommand("Stop charging", (c) => c.stopCharging(), {
      optimistic: stopChargingPatch,
    });
    expect(methods(fetch)).toEqual([
      "GET ?include=info,status,fuelStatus,odometer,parkingPosition,airConditioning,auxiliaryHeating,activeVentilation,charging,operations",
      "POST /charging/stop",
    ]);

    await vi.advanceTimersByTimeAsync(89_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    // Regular polling continues one interval after the refresh.
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(fetch).toHaveBeenCalledTimes(4);
    controller.stop();
  });

  it("coalesces the refresh of several commands", async () => {
    const fetch = routedFetch();
    const { controller } = setup(fetch, { refreshDelaySeconds: 90 });
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    await controller.runCommand("Start air conditioning", (c) =>
      c.startAirConditioning({}),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await controller.runCommand("Stop air conditioning", (c) =>
      c.stopAirConditioning(),
    );
    await vi.advanceTimersByTimeAsync(90_000);
    expect(methods(fetch).filter((m) => m.startsWith("GET"))).toHaveLength(2);
    controller.stop();
  });

  it("sends no extra request after a command by default", async () => {
    const fetch = routedFetch();
    const { controller } = setup(fetch);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    await controller.runCommand("Start charging", (c) => c.startCharging());
    await vi.advanceTimersByTimeAsync(5 * MINUTE - 1);
    expect(fetch).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it("hides operations the vehicle rejects as unsupported", async () => {
    const fetch = routedFetch([
      mockResponse({ body: loadFixture("enyaq") }),
      mockResponse({
        status: 422,
        body: problem(422, "operation-not-supported"),
      }),
    ]);
    const { controller, log } = setup(fetch);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const names = () =>
      controller.snapshot?.vehicle.operations?.map((o) => o.name);
    expect(names()).toContain("startCharging");

    await expect(
      controller.runCommand("Start charging", (c) => c.startCharging(), {
        operations: ["startCharging"],
      }),
    ).rejects.toMatchObject({ problemType: "operation-not-supported" });
    expect(names()).not.toContain("startCharging");
    expect(names()).toContain("stopCharging");
    expect(log.warn).toHaveBeenCalledWith(
      "The vehicle does not support startCharging; the control will be removed",
    );

    // Later polls keep it hidden, although the vehicle still lists it.
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(names()).not.toContain("startCharging");
    controller.stop();
  });

  it("uses the command client when a separate key is configured", async () => {
    const fetch = routedFetch();
    const { controller } = setup(fetch, { separateCommandKey: true });
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    await controller.runCommand("Start charging", (c) => c.startCharging());
    const keys = fetch.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>)["X-API-Key"],
    );
    expect(keys).toEqual([TEST_TOKEN, TEST_COMMAND_TOKEN]);
    controller.stop();
  });

  it("rethrows failures without patching the cache", async () => {
    const fetch = routedFetch([
      mockResponse({ body: loadFixture("enyaq") }),
      mockResponse({ status: 422, body: problem(422, "operation-disabled") }),
    ]);
    const { controller, log } = setup(fetch);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const patch = vi.fn();
    await expect(
      controller.runCommand("Start charging", (c) => c.startCharging(), {
        operations: ["startCharging"],
        optimistic: { part: "charging", apply: patch },
      }),
    ).rejects.toMatchObject({
      status: 422,
    });
    expect(patch).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "Start charging failed: this function is currently disabled for the vehicle",
    );
    // A disabled operation is temporary, so its control stays.
    expect(
      controller.snapshot?.vehicle.operations?.map((o) => o.name),
    ).toContain("startCharging");
    controller.stop();
  });

  it("rejects commands when the budget is exhausted", async () => {
    const fetch = mockFetch();
    const { controller, budget } = setup(fetch);
    for (let i = 0; i < 20; i++) {
      budget.record();
    }
    await expect(
      controller.runCommand("Start charging", (c) => c.startCharging()),
    ).rejects.toMatchObject({
      name: "BudgetExhaustedError",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("VehicleController key expiry", () => {
  it("warns within seven days of expiry, at most daily", () => {
    const { controller, log } = setup();
    const now = Date.now();
    controller.noteKeyExpiry(
      "API key",
      new Date(now + 30 * 24 * 60 * MINUTE),
      now,
    );
    expect(log.warn).not.toHaveBeenCalled();
    controller.noteKeyExpiry(
      "API key",
      new Date(now + 3 * 24 * 60 * MINUTE),
      now,
    );
    controller.noteKeyExpiry(
      "API key",
      new Date(now + 3 * 24 * 60 * MINUTE),
      now + MINUTE,
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toContain("in 3 day(s)");
    controller.noteKeyExpiry(
      "command key",
      new Date(now + 24 * 60 * MINUTE),
      now,
    );
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});
