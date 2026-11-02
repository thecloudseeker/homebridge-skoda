import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEATURES,
  MIN_POLLING_INTERVAL_MINUTES,
} from "../src/config.js";
import { PLATFORM_NAME } from "../src/settings.js";

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
