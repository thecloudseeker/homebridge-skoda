import * as hapNodejs from "@homebridge/hap-nodejs";
import type {
  API,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from "homebridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkodaPlatform } from "../src/platform.js";
import {
  TEST_TOKEN,
  TEST_VIN,
  loadFixture,
  mockResponse,
  problem,
} from "./helpers.js";

const hap = hapNodejs as unknown as API["hap"];

function fakeApi() {
  const handlers = new Map<string, () => void>();
  const api = {
    hap,
    platformAccessory: hapNodejs.Accessory,
    on: (event: string, handler: () => void) => handlers.set(event, handler),
    registerPlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(),
    updatePlatformAccessories: vi.fn(),
  };
  return {
    api: api as unknown as API,
    register: api.registerPlatformAccessories,
    update: api.updatePlatformAccessories,
    launch: () => handlers.get("didFinishLaunching")?.(),
    shutdown: () => handlers.get("shutdown")?.(),
  };
}

function fakeLog() {
  return Object.assign(vi.fn(), {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    log: vi.fn(),
  }) as unknown as Logging;
}

const config = {
  platform: "Skoda",
  vehicles: [{ name: "Octi", vin: TEST_VIN, token: TEST_TOKEN }],
} as unknown as PlatformConfig;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SkodaPlatform", () => {
  it("publishes a new vehicle only once its services exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(mockResponse({ body: loadFixture("gasoline-live") })),
      ),
    );
    const { api, register, update, launch, shutdown } = fakeApi();
    new SkodaPlatform(fakeLog(), config, api);
    launch();
    expect(register).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    expect(register).toHaveBeenCalledOnce();
    // Registering saves the new services; no separate cache update is needed.
    expect(update).not.toHaveBeenCalled();
    const [accessory] = register.mock.calls[0]![2] as PlatformAccessory[];
    const names = accessory!.services
      .filter((service) => service.subtype)
      .map(
        (service) =>
          service.getCharacteristic(hap.Characteristic.ConfiguredName).value,
      );
    expect(names).toEqual([
      "Fuel",
      "Doors",
      "Windows",
      "Trunk",
      "Bonnet",
      "Sunroof",
      "Locked",
    ]);

    // Later polls do not register the vehicle again.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(register).toHaveBeenCalledOnce();
    shutdown();
  });

  it("waits with publishing while the API is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          mockResponse({ status: 503, body: problem(503) }),
        )
        .mockResolvedValue(
          mockResponse({ body: loadFixture("gasoline-live") }),
        ),
    );
    const { api, register, launch, shutdown } = fakeApi();
    new SkodaPlatform(fakeLog(), config, api);
    launch();
    await vi.advanceTimersByTimeAsync(0);
    expect(register).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(register).toHaveBeenCalledOnce();
    shutdown();
  });

  it("keeps a cached vehicle whose entry is invalid, without polling", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { api, launch, shutdown } = fakeApi();
    const log = fakeLog();
    const platform = new SkodaPlatform(
      log,
      {
        ...config,
        vehicles: [{ name: "Octi", vin: TEST_VIN, token: "" }],
      },
      api,
    );
    const uuid = hap.uuid.generate(
      `@thecloudseeker/homebridge-skoda:${TEST_VIN}`,
    );
    const cached = new hapNodejs.Accessory("Octi", uuid);
    const outlet = cached.addService(
      hapNodejs.Service.Outlet,
      "Charging",
      "charging",
    );
    const doors = cached.addService(
      hapNodejs.Service.ContactSensor,
      "Doors",
      "doors",
    );
    platform.configureAccessory(cached as unknown as PlatformAccessory);
    launch();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();
    // The Home app shows the kept vehicle as unreachable instead of switches that do nothing.
    const on = outlet.getCharacteristic(hapNodejs.Characteristic.On);
    await expect(on.handleSetRequest(true)).rejects.toBe(-70402);
    await expect(on.handleGetRequest()).rejects.toBe(-70402);
    await expect(
      doors
        .getCharacteristic(hapNodejs.Characteristic.ContactSensorState)
        .handleGetRequest(),
    ).rejects.toBe(-70402);
    expect(fetch).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      "Skipping vehicle: vehicles[0].token is missing",
    );
    expect(log.warn).toHaveBeenCalledWith(
      "Keeping vehicle …9999 in HomeKit, but not updating it until vehicles[0] is fixed",
    );
    shutdown();
  });

  it("removes a cached vehicle that is no longer configured", () => {
    const { api, launch, shutdown } = fakeApi();
    const platform = new SkodaPlatform(
      fakeLog(),
      { ...config, vehicles: [] },
      api,
    );
    const uuid = hap.uuid.generate(
      `@thecloudseeker/homebridge-skoda:${TEST_VIN}`,
    );
    const cached = new hapNodejs.Accessory(
      "Octi",
      uuid,
    ) as unknown as PlatformAccessory;
    platform.configureAccessory(cached);
    launch();
    expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(
      "@thecloudseeker/homebridge-skoda",
      "Skoda",
      [cached],
    );
    shutdown();
  });

  it("applies a new name from the config to a cached vehicle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(mockResponse({ body: loadFixture("gasoline-live") })),
      ),
    );
    const { api, update, launch, shutdown } = fakeApi();
    const log = fakeLog();
    const platform = new SkodaPlatform(log, config, api);
    const uuid = hap.uuid.generate(
      `@thecloudseeker/homebridge-skoda:${TEST_VIN}`,
    );
    const cached = new hapNodejs.Accessory("Old name", uuid);
    // The HAP accessory stands in for Homebridge's PlatformAccessory, which adds this method.
    const platformAccessory = Object.assign(cached, {
      updateDisplayName(name: string) {
        cached.displayName = name;
      },
    });
    platform.configureAccessory(
      platformAccessory as unknown as PlatformAccessory,
    );
    launch();
    expect(cached.displayName).toBe("Octi");
    expect(
      cached
        .getService(hapNodejs.Service.AccessoryInformation)
        ?.getCharacteristic(hapNodejs.Characteristic.Name).value,
    ).toBe("Octi");
    expect(update).toHaveBeenCalledWith([platformAccessory]);
    await vi.advanceTimersByTimeAsync(0);
    shutdown();
  });

  it("keeps a cached vehicle published from the start", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(mockResponse({ body: loadFixture("gasoline-live") })),
      ),
    );
    const { api, register, update, launch, shutdown } = fakeApi();
    const platform = new SkodaPlatform(fakeLog(), config, api);
    const uuid = hap.uuid.generate(
      `@thecloudseeker/homebridge-skoda:${TEST_VIN}`,
    );
    platform.configureAccessory(
      new hapNodejs.Accessory("Octi", uuid) as unknown as PlatformAccessory,
    );
    launch();
    await vi.advanceTimersByTimeAsync(0);
    expect(register).not.toHaveBeenCalled();
    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();
    // The services added to the cached vehicle are saved to the accessory cache.
    expect(update).toHaveBeenCalledOnce();
    shutdown();
  });
});
