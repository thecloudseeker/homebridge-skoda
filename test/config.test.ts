import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FEATURES,
  clampTemperature,
  configuredVin,
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

  it("reads the charge limits with a switch", () => {
    expect(parse(base).settings.chargingLimits).toEqual([80, 90, 100]);
    expect(
      parse({ ...base, chargingLimits: [100, "70", 70] }).settings
        .chargingLimits,
    ).toEqual([70, 100]);

    const { settings, warnings } = parse({
      ...base,
      chargingLimits: [85, 40, 90],
    });
    expect(settings.chargingLimits).toEqual([90]);
    expect(warnings).toEqual([
      "vehicles[0].chargingLimits: 85, 40 ignored; limits are 50–100 in steps of 10",
    ]);

    // The settings form saves an empty list when nothing is checked.
    const empty = parse({ ...base, chargingLimits: [] });
    expect(empty.settings.chargingLimits).toEqual([80, 90, 100]);
    expect(empty.warnings).toEqual([]);

    const invalid = parse({ ...base, chargingLimits: [45] });
    expect(invalid.settings.chargingLimits).toEqual([80, 90, 100]);
    expect(invalid.warnings).toHaveLength(2);
  });

  it("reads a real config saved by the 0.4.0 settings form", () => {
    // Location, VIN and key replaced; the rest as saved for a combustion vehicle.
    const { settings, warnings } = parse({
      name: "Octi",
      vin: TEST_VIN,
      token: TEST_TOKEN,
      drive: "combustion",
      home: { lat: 50.4128, lon: 14.9069 },
      lowBatteryThreshold: 40,
      features: {
        fuelLevel: true,
        fuelLevelSensor: true,
        climate: true,
        auxiliaryHeating: false,
        activeVentilation: true,
        presence: true,
        doors: true,
        windows: true,
        trunk: true,
        bonnet: true,
        sunroof: true,
        lock: true,
        lights: true,
        windowHeating: false,
      },
    });
    expect(warnings).toEqual([]);
    expect(settings).toMatchObject({
      name: "Octi",
      lowBatteryThreshold: 40,
      pollingIntervalMinutes: 5,
      home: { latitude: 50.4128, longitude: 14.9069, radiusMeters: 150 },
      chargingLimits: [80, 90, 100],
    });
    expect(settings.features).toEqual({
      ...DEFAULT_FEATURES,
      fuelLevelSensor: true,
      auxiliaryHeating: false,
      activeVentilation: true,
      lights: true,
    });
  });

  it("keeps the charge limit off for configs that turned the old lightbulb off", () => {
    const off = (features: object) =>
      parse({ ...base, features }).settings.features.chargingLimitPresets;
    expect(off({ chargingLimit: false })).toBe(false);
    // The settings form shows the switches as on, so the log explains until the new option is set.
    expect(
      parse({ ...base, features: { chargingLimit: false } }).warnings,
    ).toEqual([
      "vehicles[0].features.chargingLimit is replaced by chargingLimitPresets. The charge limit switches stay off, " +
        'as the lightbulb was. The settings show "Charge limit switches" as on: uncheck it and save to keep them off, ' +
        "or save as shown to turn them on",
    ]);
    expect(
      parse({
        ...base,
        features: { chargingLimit: false, chargingLimitPresets: false },
      }).warnings,
    ).toEqual([]);
    expect(off({ chargingLimit: false, chargingLimitPresets: true })).toBe(
      true,
    );
    expect(off({ chargingLimit: true })).toBe(true);
    expect(off({})).toBe(true);
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
      expect(warnings[0]).toContain(expected ? '"Allow"' : '"Do not allow"');
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

describe("configuredVin", () => {
  it("returns the normalized VIN of an entry, also when other fields are invalid", () => {
    expect(configuredVin({ vin: " tmbjb9ny5rf999999 ", token: "" })).toBe(
      TEST_VIN,
    );
    expect(configuredVin({ vin: "TOO-SHORT" })).toBeUndefined();
    expect(configuredVin("not an object")).toBeUndefined();
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
