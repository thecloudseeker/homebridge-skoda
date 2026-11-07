import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkodaApiClient } from "../src/api/client.js";
import { SkodaApiError } from "../src/api/errors.js";
import { RateBudget } from "../src/api/rateBudget.js";
import type { Vehicle } from "../src/api/types.js";
import { VehicleController } from "../src/vehicle/vehicleController.js";
import {
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

function setup(fetch: typeof globalThis.fetch = routedFetch()) {
  const budget = new RateBudget();
  const log = silentLogger();
  const client = new SkodaApiClient({
    token: TEST_TOKEN,
    vin: TEST_VIN,
    budget,
    fetch,
  });
  const controller = new VehicleController({
    client,
    log,
    pollingIntervalMinutes: 5,
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
    // A command every two minutes for three hours.
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

  it("falls back to the vehicle's own report, not the expected state, for an unavailable part", async () => {
    // After the first poll the charging part is temporarily unavailable for good.
    let polls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => {
      if (init?.method !== "GET") {
        return Promise.resolve(mockResponse({ status: 202 }));
      }
      const body = loadFixture("enyaq");
      if (polls++ > 0) {
        delete body.vehicle.charging;
        body.errors = [{ type: "CHARGING_UNAVAILABLE" }];
      }
      return Promise.resolve(mockResponse({ body }));
    });
    const { controller } = setup(fetch);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    await controller.runCommand("Stop charging", (c) => c.stopCharging(), {
      optimistic: stopChargingPatch,
    });
    const state = () => controller.snapshot?.vehicle.charging?.status?.state;
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(state()).toBe("READY_FOR_CHARGING");
    // After 15 minutes the expected state ends, and the last report shows again.
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(state()).toBe("CHARGING");
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(state()).toBe("CHARGING");
    controller.stop();
  });

  it("sends no extra request after a command", async () => {
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

describe("VehicleController blocked commands", () => {
  it("logs once that commands are blocked, until the next successful update", async () => {
    const { controller, log } = setup();
    controller.noteBlockedCommand();
    controller.noteBlockedCommand();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      "No current vehicle data; commands from HomeKit are not sent until the next successful update",
    );
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    controller.noteBlockedCommand();
    expect(log.warn).toHaveBeenCalledTimes(2);
    controller.stop();
  });
});

describe("VehicleController key expiry", () => {
  it("warns within seven days of expiry, at most daily", () => {
    const { controller, log } = setup();
    const now = Date.now();
    controller.noteKeyExpiry(new Date(now + 30 * 24 * 60 * MINUTE), now);
    expect(log.warn).not.toHaveBeenCalled();
    controller.noteKeyExpiry(new Date(now + 3 * 24 * 60 * MINUTE), now);
    controller.noteKeyExpiry(
      new Date(now + 3 * 24 * 60 * MINUTE),
      now + MINUTE,
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toContain("The API key expires on");
    expect(log.warn.mock.calls[0]?.[0]).toContain("in 3 day(s)");
    controller.noteKeyExpiry(
      new Date(now + 3 * 24 * 60 * MINUTE),
      now + 24 * 60 * MINUTE,
    );
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});
