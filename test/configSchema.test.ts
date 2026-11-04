import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEATURES,
  parseVehicleConfig,
  MIN_POLLING_INTERVAL_MINUTES,
} from "../src/config.js";
import { PLATFORM_NAME } from "../src/settings.js";
import { TEST_TOKEN, TEST_VIN } from "./helpers.js";

interface Schema {
  pluginAlias: string;
  schema: {
    properties: {
      vehicles: {
        items: {
          properties: Record<
            string,
            {
              minimum?: number;
              properties?: Record<string, { default?: unknown }>;
            }
          >;
        };
      };
    };
  };
  layout: unknown;
}

const schema = JSON.parse(
  readFileSync(new URL("../config.schema.json", import.meta.url), "utf8"),
) as Schema;
const vehicle = schema.schema.properties.vehicles.items.properties;

describe("config.schema.json", () => {
  it("uses the platform name as alias", () => {
    expect(schema.pluginAlias).toBe(PLATFORM_NAME);
  });

  it("lists every feature toggle with the code default", () => {
    const features = vehicle.features?.properties ?? {};
    expect(Object.keys(features).sort()).toEqual(
      Object.keys(DEFAULT_FEATURES).sort(),
    );
    for (const [key, value] of Object.entries(DEFAULT_FEATURES)) {
      expect(features[key]?.default, key).toBe(value);
    }
  });

  it("enforces the rate-limit minimum for the polling interval", () => {
    expect(vehicle.pollingIntervalMinutes?.minimum).toBe(
      MIN_POLLING_INTERVAL_MINUTES,
    );
  });

  it("renders all secrets as password fields", () => {
    const layout = JSON.stringify(schema.layout);
    for (const key of ["token", "spin"]) {
      expect(layout).toContain(`{"key":"vehicles[].${key}","type":"password"}`);
    }
  });

  it("keeps all fields of a vehicle in one array item", () => {
    // Several top-level layout items inside an array make the Homebridge UI store each of them
    // as a separate vehicle entry, so everything must sit in one container.
    const [vehicles] = schema.layout as {
      key: string;
      items: { type: string; items?: unknown[] }[];
    }[];
    expect(vehicles?.key).toBe("vehicles");
    expect(vehicles?.items).toHaveLength(1);
    expect(vehicles?.items[0]?.type).toBe("section");

    const keys = JSON.stringify(vehicles).match(/vehicles\[\]\.[\w.]+/g) ?? [];
    const fields = Object.keys(vehicle).filter(
      (key) => key !== "features" && key !== "home",
    );
    for (const field of fields) {
      expect(keys, field).toContain(`vehicles[].${field}`);
    }
  });
});

/** The Homebridge UI uses draft-3 style `required: true` on properties; JSON Schema validators do not. */
function validatorSchema(): object {
  const copy = structuredClone(schema.schema) as object;
  const strip = (node: unknown): void => {
    if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      if (typeof record.required === "boolean") {
        delete record.required;
      }
      Object.values(record).forEach(strip);
    }
  };
  strip(copy);
  return copy;
}

/**
 * Configs as earlier versions saved them. A settings change must keep them valid, or the Homebridge
 * UI marks the whole config as invalid (as 0.3.0 did with `airConditioningWithoutExternalPower`).
 */
const SAVED_CONFIGS: Record<
  string,
  { vehicle: object; allowance: boolean | undefined }
> = {
  "0.1.x and 0.2.0, checkbox and removed options": {
    vehicle: {
      name: "Enyaq",
      vin: TEST_VIN,
      token: TEST_TOKEN,
      commandToken: "old-second-key",
      commandRefreshDelaySeconds: 90,
      airConditioningWithoutExternalPower: false,
      features: { battery: true, climate: true },
    },
    allowance: false,
  },
  "0.3.0, checkbox value turned into text by the settings form": {
    vehicle: {
      name: "Octi",
      vin: TEST_VIN,
      token: TEST_TOKEN,
      home: { lat: 50.1, lon: 14.4 },
      lowBatteryThreshold: 40,
      airConditioningWithoutExternalPower: "false",
      features: { fuelLevel: true, lights: true, windowHeating: false },
    },
    allowance: false,
  },
  "0.3.1 and later": {
    vehicle: {
      name: "Enyaq",
      vin: TEST_VIN,
      token: TEST_TOKEN,
      airConditioningOnBattery: "allow",
      pollingIntervalMinutes: 10,
    },
    allowance: true,
  },
};

describe("configs saved by earlier versions", () => {
  const validate = new Ajv({ strict: false, allErrors: true }).compile(
    validatorSchema(),
  );

  for (const [version, { vehicle: saved, allowance }] of Object.entries(
    SAVED_CONFIGS,
  )) {
    it(`stay valid and keep their meaning: ${version}`, () => {
      const valid = validate({ platform: PLATFORM_NAME, vehicles: [saved] });
      expect(validate.errors ?? [], version).toEqual([]);
      expect(valid).toBe(true);

      const result = parseVehicleConfig(saved, 0);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.settings.airConditioningWithoutExternalPower).toBe(
          allowance,
        );
      }
    });
  }
});

describe("settings form texts", () => {
  it("describes every field, feature switch and section", () => {
    const missing: string[] = [];
    for (const [key, field] of Object.entries(vehicle)) {
      const nested = field.properties;
      if (nested) {
        for (const [child, value] of Object.entries(nested)) {
          if (!(value as { description?: string }).description) {
            missing.push(`${key}.${child}`);
          }
        }
      } else if (!(field as { description?: string }).description) {
        missing.push(key);
      }
    }
    const undescribed: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
      } else if (node && typeof node === "object") {
        const item = node as {
          type?: string;
          title?: string;
          description?: string;
          items?: unknown;
        };
        if (item.type === "fieldset" && !item.description) {
          undescribed.push(item.title ?? "?");
        }
        walk(item.items);
      }
    };
    walk(schema.layout);
    expect(missing).toEqual([]);
    expect(undescribed).toEqual([]);
  });
});
