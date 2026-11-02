import * as hapNodejs from "@homebridge/hap-nodejs";
import type {
  API,
  Characteristic as CharacteristicClass,
  PlatformAccessory,
  WithUUID,
} from "homebridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VehicleAccessory } from "../src/accessory/vehicleAccessory.js";
import { SkodaApiClient } from "../src/api/client.js";
import { RateBudget } from "../src/api/rateBudget.js";
import { parseVehicleConfig, type VehicleSettings } from "../src/config.js";
import { VehicleController } from "../src/vehicle/vehicleController.js";
import {
  TEST_TOKEN,
  TEST_VIN,
  loadFixture,
  mockResponse,
  problem,
  silentLogger,
} from "./helpers.js";

const hap = hapNodejs as unknown as API["hap"];
const { Characteristic, Service } = hap;

function settingsFor(overrides: Record<string, unknown> = {}): VehicleSettings {
  const result = parseVehicleConfig(
    {
      name: "Enyaq",
      vin: TEST_VIN,
      token: TEST_TOKEN,
      spin: "0000",
      home: { lat: 50.4128, lon: 14.9069 },
      ...overrides,
    },
    0,
  );
  if (!result.ok) {
    throw new Error(result.errors.join(", "));
  }
  return result.settings;
}

function setup(responses: Response[], settings = settingsFor()) {
  const queue = [...responses];
  const fetch = vi.fn<typeof globalThis.fetch>((_url, init) =>
    Promise.resolve(
      queue.shift() ??
        (init?.method === "GET"
          ? mockResponse({ body: loadFixture("enyaq") })
          : mockResponse({ status: 202 })),
    ),
  );
  const client = new SkodaApiClient({
    token: TEST_TOKEN,
    vin: TEST_VIN,
    budget: new RateBudget(),
    fetch,
  });
  const log = silentLogger();
  const controller = new VehicleController({
    client,
    log,
    pollingIntervalMinutes: settings.pollingIntervalMinutes,
  });
  const accessory = new hapNodejs.Accessory(
    "Enyaq",
    hap.uuid.generate(TEST_VIN),
  ) as unknown as PlatformAccessory;
  const onServicesChanged = vi.fn();
  new VehicleAccessory({
    hap,
    accessory,
    controller,
    settings,
    log,
    onServicesChanged,
  });
  return { accessory, controller, fetch, log, onServicesChanged };
}

const value = (
  accessory: PlatformAccessory,
  service: typeof Service.Battery,
  subtype: string,
  characteristic: WithUUID<new () => CharacteristicClass>,
) =>
  accessory.getServiceById(service, subtype)?.getCharacteristic(characteristic)
    .value;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("VehicleAccessory", () => {
  it("creates no services before the first poll", () => {
    const { accessory } = setup([]);
    expect(accessory.services.map((s) => s.UUID)).toEqual([
      Service.AccessoryInformation.UUID,
    ]);
  });

  it("creates and fills the services an electric vehicle supports", async () => {
    const { accessory, controller } = setup([]);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);

    const subtypes = accessory.services.map((s) => s.subtype).filter(Boolean);
    expect(subtypes).toEqual([
      "battery",
      "charging",
      "charging-limit",
      "climate",
      "home",
      "doors",
      "windows",
      "trunk",
      "bonnet",
      "lock",
    ]);

    expect(
      value(accessory, Service.Battery, "battery", Characteristic.BatteryLevel),
    ).toBe(62);
    expect(
      value(
        accessory,
        Service.Battery,
        "battery",
        Characteristic.ChargingState,
      ),
    ).toBe(Characteristic.ChargingState.CHARGING);
    expect(
      value(accessory, Service.Outlet, "charging", Characteristic.On),
    ).toBe(true);
    expect(
      value(accessory, Service.Outlet, "charging", Characteristic.OutletInUse),
    ).toBe(true);
    expect(
      value(
        accessory,
        Service.Lightbulb,
        "charging-limit",
        Characteristic.Brightness,
      ),
    ).toBe(80);
    expect(
      value(accessory, Service.HeaterCooler, "climate", Characteristic.Active),
    ).toBe(Characteristic.Active.INACTIVE);
    expect(
      value(
        accessory,
        Service.HeaterCooler,
        "climate",
        Characteristic.CurrentTemperature,
      ),
    ).toBe(21.5);
    expect(
      value(
        accessory,
        Service.HeaterCooler,
        "climate",
        Characteristic.HeatingThresholdTemperature,
      ),
    ).toBe(21.5);
    expect(
      value(
        accessory,
        Service.OccupancySensor,
        "home",
        Characteristic.OccupancyDetected,
      ),
    ).toBe(Characteristic.OccupancyDetected.OCCUPANCY_DETECTED);
    expect(
      value(
        accessory,
        Service.OccupancySensor,
        "home",
        Characteristic.StatusFault,
      ),
    ).toBe(Characteristic.StatusFault.NO_FAULT);
    expect(
      value(
        accessory,
        Service.ContactSensor,
        "lock",
        Characteristic.ContactSensorState,
      ),
    ).toBe(Characteristic.ContactSensorState.CONTACT_DETECTED);
    controller.stop();
  });

  it("adds the optional fuel level and lights sensors", async () => {
    const lightsOn = loadFixture("combustion");
    lightsOn.vehicle.status!.overall.lights = "ON";
    const { accessory, controller } = setup(
      [mockResponse({ body: lightsOn })],
      settingsFor({ features: { fuelLevelSensor: true, lights: true } }),
    );
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      value(
        accessory,
        Service.HumiditySensor,
        "fuel-level",
        Characteristic.CurrentRelativeHumidity,
      ),
    ).toBe(65);
    expect(
      value(
        accessory,
        Service.ContactSensor,
        "lights",
        Characteristic.ContactSensorState,
      ),
    ).toBe(Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
    controller.stop();
  });

  it("adds the optional window heating and plug lock sensors", async () => {
    const enyaq = loadFixture("enyaq");
    enyaq.vehicle.airConditioning!.windowHeating = { front: "ON", rear: "OFF" };
    const { accessory, controller } = setup(
      [mockResponse({ body: enyaq })],
      settingsFor({ features: { windowHeating: true, plugLock: true } }),
    );
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const { CONTACT_DETECTED, CONTACT_NOT_DETECTED } =
      Characteristic.ContactSensorState;
    const state = (subtype: string) =>
      value(
        accessory,
        Service.ContactSensor,
        subtype,
        Characteristic.ContactSensorState,
      );
    expect(state("windowHeating")).toBe(CONTACT_NOT_DETECTED);
    expect(state("plugLock")).toBe(CONTACT_DETECTED);
    controller.stop();
  });

  it("logs what the vehicle supports, including features turned off", async () => {
    const { controller, fetch, log } = setup([]);
    fetch.mockImplementation(() =>
      Promise.resolve(mockResponse({ body: loadFixture("gasoline-live") })),
    );
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(log.info).toHaveBeenCalledWith(
      "Supported by the vehicle: Fuel, Home, Doors, Windows, Trunk, Bonnet, Sunroof, Locked. " +
        "Also supported, but turned off: Fuel Level (features.fuelLevelSensor), " +
        "Ventilation (features.activeVentilation), Lights (features.lights)",
    );
    // Later updates with the same support do not repeat it.
    log.info.mockClear();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(log.info).not.toHaveBeenCalledWith(
      expect.stringContaining("Supported by the vehicle"),
    );
    controller.stop();
  });

  it("honours feature toggles", async () => {
    const { accessory, controller } = setup(
      [],
      settingsFor({
        features: {
          climate: false,
          stateOfChargeSensor: true,
          activeVentilation: true,
        },
      }),
    );
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const subtypes = accessory.services.map((s) => s.subtype);
    expect(subtypes).not.toContain("climate");
    expect(subtypes).toContain("state-of-charge");
    expect(subtypes).toContain("active-ventilation");
    expect(
      value(
        accessory,
        Service.HumiditySensor,
        "state-of-charge",
        Characteristic.CurrentRelativeHumidity,
      ),
    ).toBe(62);
    controller.stop();
  });

  it("creates the auxiliary heating switch only with an S-PIN", async () => {
    const withPin = setup([mockResponse({ body: loadFixture("combustion") })]);
    withPin.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(withPin.accessory.services.map((s) => s.subtype)).toContain(
      "auxiliary-heating",
    );
    expect(withPin.accessory.services.map((s) => s.subtype)).not.toContain(
      "battery",
    );
    // A combustion vehicle shows its fuel level as a battery that cannot be charged.
    expect(
      value(
        withPin.accessory,
        Service.Battery,
        "fuel",
        Characteristic.BatteryLevel,
      ),
    ).toBe(65);
    expect(
      value(
        withPin.accessory,
        Service.Battery,
        "fuel",
        Characteristic.ChargingState,
      ),
    ).toBe(Characteristic.ChargingState.NOT_CHARGEABLE);
    withPin.controller.stop();

    const withoutPin = setup(
      [mockResponse({ body: loadFixture("combustion") })],
      settingsFor({ spin: "" }),
    );
    withoutPin.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(withoutPin.accessory.services.map((s) => s.subtype)).not.toContain(
      "auxiliary-heating",
    );
    withoutPin.controller.stop();
  });

  it("keeps services while the API is unreachable and flags stale data", async () => {
    const { accessory, controller } = setup([
      mockResponse({ body: loadFixture("enyaq") }),
      ...Array.from({ length: 5 }, () =>
        mockResponse({ status: 503, body: problem(503) }),
      ),
    ]);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(accessory.getServiceById(Service.Battery, "battery")).toBeDefined();
    expect(
      value(
        accessory,
        Service.ContactSensor,
        "doors",
        Characteristic.StatusFault,
      ),
    ).toBe(Characteristic.StatusFault.GENERAL_FAULT);
    controller.stop();
  });

  it("removes a control only after two updates without its operations", async () => {
    const withoutCharging = () => {
      const body = loadFixture("enyaq");
      body.vehicle.operations = body.vehicle.operations!.filter(
        (o) => o.name !== "startCharging" && o.name !== "stopCharging",
      );
      return mockResponse({ body });
    };
    const { accessory, controller, onServicesChanged } = setup([
      mockResponse({ body: loadFixture("enyaq") }),
      withoutCharging(),
      withoutCharging(),
    ]);
    const charging = () => accessory.getServiceById(Service.Outlet, "charging");
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(charging()).toBeDefined();
    expect(onServicesChanged).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(charging()).toBeDefined();
    expect(onServicesChanged).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(charging()).toBeUndefined();
    expect(accessory.getServiceById(Service.Battery, "battery")).toBeDefined();
    expect(onServicesChanged).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it("keeps a control when a single update leaves out its operations", async () => {
    const withoutCharging = loadFixture("enyaq");
    withoutCharging.vehicle.operations = [];
    const { accessory, controller } = setup([
      mockResponse({ body: loadFixture("enyaq") }),
      mockResponse({ body: withoutCharging }),
      mockResponse({ body: loadFixture("enyaq") }),
      mockResponse({ body: withoutCharging }),
    ]);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3 * 5 * 60_000);
    expect(accessory.getServiceById(Service.Outlet, "charging")).toBeDefined();
    controller.stop();
  });

  it("removes a control the vehicle rejects as unsupported", async () => {
    const { accessory, controller } = setup([
      mockResponse({ body: loadFixture("enyaq") }),
      mockResponse({
        status: 422,
        body: problem(422, "operation-not-supported"),
      }),
    ]);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const on = accessory
      .getServiceById(Service.Outlet, "charging")!
      .getCharacteristic(Characteristic.On);
    await expect(on.handleSetRequest(false)).rejects.toBe(-70402);
    await vi.advanceTimersByTimeAsync(2 * 5 * 60_000);
    expect(
      accessory.getServiceById(Service.Outlet, "charging"),
    ).toBeUndefined();
    controller.stop();
  });

  it("starts air conditioning with the target temperature", async () => {
    const { accessory, controller, fetch } = setup([]);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);

    const active = accessory
      .getServiceById(Service.HeaterCooler, "climate")!
      .getCharacteristic(Characteristic.Active);
    await active.handleSetRequest(Characteristic.Active.ACTIVE);

    const [url, init] = fetch.mock.calls[1]!;
    expect(url).toMatch(/\/air-conditioning\/start$/);
    expect(JSON.parse(init!.body as string)).toEqual({
      targetTemperature: { value: 21.5, unit: "CELSIUS" },
    });
    expect(active.value).toBe(Characteristic.Active.ACTIVE);
    controller.stop();
  });

  it("reports a failed command as no response and reverts the switch", async () => {
    const { accessory, controller } = setup([
      mockResponse({ body: loadFixture("enyaq") }),
      mockResponse({ status: 422, body: problem(422, "operation-disabled") }),
    ]);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);

    const on = accessory
      .getServiceById(Service.Outlet, "charging")!
      .getCharacteristic(Characteristic.On);
    await expect(on.handleSetRequest(false)).rejects.toBe(-70402);
    await vi.advanceTimersByTimeAsync(500);
    expect(on.value).toBe(true);
    controller.stop();
  });

  it("debounces and normalizes the charging limit", async () => {
    const { accessory, controller, fetch } = setup([]);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);

    const brightness = accessory
      .getServiceById(Service.Lightbulb, "charging-limit")!
      .getCharacteristic(Characteristic.Brightness);
    await brightness.handleSetRequest(60);
    await brightness.handleSetRequest(73);
    await vi.advanceTimersByTimeAsync(3000);

    const commands = fetch.mock.calls.filter(
      ([, init]) => init?.method === "PUT",
    );
    expect(commands).toHaveLength(1);
    expect(JSON.parse(commands[0]![1]!.body as string)).toEqual({
      targetStateOfChargeInPercent: 70,
    });
    expect(brightness.value).toBe(70);
    controller.stop();
  });

  it("shows the ventilation as reported, like the MyŠkoda app", async () => {
    // Observed live: a ventilation started through the Public API is reported as OFF for its whole run.
    const gasoline = loadFixture("gasoline-live");
    const { accessory, controller, fetch, log } = setup(
      [],
      settingsFor({ features: { activeVentilation: true } }),
    );
    fetch.mockImplementation((_url, init) =>
      Promise.resolve(
        init?.method === "GET"
          ? mockResponse({ body: gasoline })
          : mockResponse({ status: 202 }),
      ),
    );
    controller.start();
    await vi.advanceTimersByTimeAsync(0);

    const on = accessory
      .getServiceById(Service.Switch, "active-ventilation")!
      .getCharacteristic(Characteristic.On);
    await on.handleSetRequest(true);
    expect(fetch.mock.calls[1]?.[0]).toMatch(/\/active-ventilation\/start$/);
    expect(log.info).toHaveBeenCalledWith(
      "Start active ventilation: accepted by the vehicle",
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(on.value).toBe(false);

    // It can be started again right away.
    await on.handleSetRequest(true);
    expect(fetch.mock.calls[2]?.[0]).toMatch(/\/active-ventilation\/start$/);
    controller.stop();
  });

  it("sends the S-PIN with the auxiliary heating but never logs it", async () => {
    const { accessory, controller, fetch, log } = setup(
      [mockResponse({ body: loadFixture("combustion") })],
      settingsFor({
        spin: "4711",
        auxiliaryHeatingDurationMinutes: 20,
      }),
    );
    controller.start();
    await vi.advanceTimersByTimeAsync(0);

    const on = accessory
      .getServiceById(Service.Switch, "auxiliary-heating")!
      .getCharacteristic(Characteristic.On);
    await on.handleSetRequest(true);
    const [, init] = fetch.mock.calls[1]!;
    expect(JSON.parse(init!.body as string)).toEqual({
      spin: "4711",
      durationInSeconds: 1200,
    });

    const logged = [
      ...log.debug.mock.calls,
      ...log.info.mock.calls,
      ...log.warn.mock.calls,
      ...log.error.mock.calls,
    ]
      .flat()
      .join("\n");
    expect(logged).not.toContain("4711");
    expect(logged).not.toContain(TEST_TOKEN);
    controller.stop();
  });
});
