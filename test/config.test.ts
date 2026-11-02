import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FEATURES,
  clampTemperature,
  parseVehicleConfig,
} from "../src/config.js";
import { createVehicleLogger } from "../src/util/logger.js";
import { maskVin, redact } from "../src/util/redact.js";
import { TEST_TOKEN, TEST_VIN } from "./helpers.js";

const base = { name: "Enyaq", vin: TEST_VIN, token: TEST_TOKEN };

function parse(raw: unknown) {
  const result = parseVehicleConfig(raw, 0);
  if (!result.ok) {
    throw new Error(result.errors.join("; "));
  }
  return result;
}

describe("parseVehicleConfig", () => {
  it("applies defaults", () => {
    const { settings, warnings } = parse(base);
    expect(warnings).toEqual([]);
    expect(settings).toMatchObject({
      name: "Enyaq",
      vin: TEST_VIN,
      token: TEST_TOKEN,
      pollingIntervalMinutes: 5,
      lowBatteryThreshold: 20,
      climateTemperature: 21,
      home: undefined,
    });
    // Without S-PIN and home coordinates these features cannot work.
    expect(settings.features).toEqual({
      ...DEFAULT_FEATURES,
      auxiliaryHeating: false,
      presence: false,
    });
  });

  it("normalizes the VIN and accepts an S-PIN and home", () => {
    const { settings } = parse({
      ...base,
      vin: " tmbjb9ny5rf999999 ",
      spin: "1234",
      home: { lat: 50.1, lon: 14.4, radiusMeters: 200 },
    });
    expect(settings.vin).toBe(TEST_VIN);
    expect(settings.home).toEqual({
      latitude: 50.1,
      longitude: 14.4,
      radiusMeters: 200,
    });
    expect(settings.features.auxiliaryHeating).toBe(true);
    expect(settings.features.presence).toBe(true);
  });

  it("raises a too short polling interval to the rate-limit minimum", () => {
    const { settings, warnings } = parse({
      ...base,
      pollingIntervalMinutes: 1,
    });
    expect(settings.pollingIntervalMinutes).toBe(4);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("minimum of 4");
  });

  it("warns about options that are no longer used", () => {
    const { settings, warnings } = parse({
      ...base,
      commandToken: "old-second-key",
      commandRefreshDelaySeconds: 90,
    });
    expect(warnings).toEqual([
      "vehicles[0].commandToken is no longer used and can be removed from the config",
      "vehicles[0].commandRefreshDelaySeconds is no longer used and can be removed from the config",
    ]);
    expect(JSON.stringify(settings)).not.toContain("old-second-key");
  });

  it("reads the air conditioning allowance from the settings select", () => {
    const allowance = (airConditioningOnBattery: unknown) =>
      parse({ ...base, airConditioningOnBattery }).settings
        .airConditioningWithoutExternalPower;
    expect(allowance("allow")).toBe(true);
    expect(allowance("deny")).toBe(false);
    expect(allowance("vehicle")).toBeUndefined();
    expect(allowance(undefined)).toBeUndefined();
  });

  it("still reads the old option, also as the string the 0.3.0 settings form stored", () => {
    const legacy = (airConditioningWithoutExternalPower: unknown) =>
      parse({ ...base, airConditioningWithoutExternalPower });
    for (const [value, expected] of [
      [true, true],
      [false, false],
      ["true", true],
      ["false", false],
      ["deny", false],
    ] as const) {
      const { settings, warnings } = legacy(value);
      expect(settings.airConditioningWithoutExternalPower, String(value)).toBe(
        expected,
      );
      expect(warnings[0]).toContain("replaced by airConditioningOnBattery");
    }
    // The new option wins over the old one, without a warning about the leftover.
    const both = parse({
      ...base,
      airConditioningOnBattery: "allow",
      airConditioningWithoutExternalPower: false,
    });
    expect(both.settings.airConditioningWithoutExternalPower).toBe(true);
    expect(both.warnings).toEqual([]);
  });

  it("respects feature toggles", () => {
    const { settings } = parse({
      ...base,
      features: { charging: false, stateOfChargeSensor: true, doors: "yes" },
    });
    expect(settings.features.charging).toBe(false);
    expect(settings.features.stateOfChargeSensor).toBe(true);
    expect(settings.features.doors).toBe(true);
  });

  it("rejects missing or invalid VIN and token without echoing secrets", () => {
    const result = parseVehicleConfig(
      { vin: "TMBJB9NY5RF99999I", token: "" },
      2,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        "vehicles[2].vin (…999I) is not a valid 17-character VIN",
        "vehicles[2].token is missing",
      ]);
    }
    expect(parseVehicleConfig("nope", 0).ok).toBe(false);
  });

  it("rejects out-of-range home coordinates", () => {
    const result = parseVehicleConfig(
      { ...base, home: { lat: 95, lon: 10 } },
      0,
    );
    expect(result.ok).toBe(false);
  });

  it("enforces a minimum home radius", () => {
    expect(
      parse({ ...base, home: { lat: 1, lon: 2, radiusMeters: 1 } }).settings
        .home?.radiusMeters,
    ).toBe(10);
  });
});

describe("clampTemperature", () => {
  it("rounds to 0.5 °C and clamps to 16–29.5 °C", () => {
    expect(clampTemperature(21.3)).toBe(21.5);
    expect(clampTemperature(10)).toBe(16);
    expect(clampTemperature(35)).toBe(29.5);
  });
});

describe("redaction", () => {
  it("masks the VIN to its last four characters", () => {
    expect(maskVin(TEST_VIN)).toBe("…9999");
  });

  it("removes secrets from messages", () => {
    expect(redact(`key ${TEST_TOKEN} failed`, [TEST_TOKEN, undefined])).toBe(
      "key *** failed",
    );
  });

  it("prefixes and scrubs vehicle log messages", () => {
    const log = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const vehicleLog = createVehicleLogger(log, "Enyaq", TEST_VIN, [
      TEST_TOKEN,
    ]);
    vehicleLog.warn(`request for ${TEST_VIN} with ${TEST_TOKEN}`);
    expect(log.warn).toHaveBeenCalledWith(
      "[Enyaq …9999] request for *** with ***",
    );
  });
});
