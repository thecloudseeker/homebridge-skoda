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

function setup(
  responses: Response[],
  settings = settingsFor(),
  prepare?: (accessory: PlatformAccessory) => void,
) {
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
  prepare?.(accessory);
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
      "charging-limit-80",
      "charging-limit-90",
      "charging-limit-100",
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
      [80, 90, 100].map((percent) =>
        value(
          accessory,
          Service.Switch,
          `charging-limit-${percent}`,
          Characteristic.On,
        ),
      ),
    ).toEqual([true, false, false]);
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
        Service.LockMechanism,
        "lock",
        Characteristic.LockCurrentState,
      ),
    ).toBe(Characteristic.LockCurrentState.SECURED);
    controller.stop();
  });

  it("shows the lock state as a lock that cannot be unlocked", async () => {
    const { accessory, controller } = setup([]);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);

    const target = accessory
      .getServiceById(Service.LockMechanism, "lock")!
      .getCharacteristic(Characteristic.LockTargetState);
    expect(target.value).toBe(Characteristic.LockTargetState.SECURED);
    // Without the write permission HAP answers writes with "read-only characteristic".
    expect(target.props.perms).not.toContain("pw");
    controller.stop();
  });

  it("replaces the cached Locked contact sensor of 0.3.x with the lock", async () => {
    const { accessory, controller, onServicesChanged } = setup(
      [],
      settingsFor(),
      (cached) => {
        cached.addService(Service.ContactSensor, "Locked", "lock");
      },
    );
    expect(accessory.getServiceById(Service.ContactSensor, "lock")).toBe(
      undefined,
    );
    expect(onServicesChanged).toHaveBeenCalled();
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      accessory.getServiceById(Service.LockMechanism, "lock"),
    ).toBeDefined();
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

  it("shows the cable as plugged in, and a plug lock only while plugged in", async () => {
    const unplugged = loadFixture("enyaq");
    unplugged.vehicle.charging!.status!.plugConnectionState = "DISCONNECTED";
    unplugged.vehicle.charging!.status!.plugLockState = "UNLOCKED";
    const { accessory, controller } = setup(
      [
        mockResponse({ body: loadFixture("enyaq") }),
        mockResponse({ body: unplugged }),
      ],
      settingsFor({ features: { pluggedIn: true, plugLock: true } }),
    );
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const { OCCUPANCY_DETECTED, OCCUPANCY_NOT_DETECTED } =
      Characteristic.OccupancyDetected;
    const { CONTACT_DETECTED } = Characteristic.ContactSensorState;
    const pluggedIn = () =>
      value(
        accessory,
        Service.OccupancySensor,
        "plugged-in",
        Characteristic.OccupancyDetected,
      );
    const plugLock = () =>
      value(
        accessory,
        Service.ContactSensor,
        "plugLock",
        Characteristic.ContactSensorState,
      );
    expect(pluggedIn()).toBe(OCCUPANCY_DETECTED);
    expect(plugLock()).toBe(CONTACT_DETECTED);

    // Unplugged: the vehicle reports the plug unlocked, which is no reason to alert.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(pluggedIn()).toBe(OCCUPANCY_NOT_DETECTED);
    expect(plugLock()).toBe(CONTACT_DETECTED);
    controller.stop();
  });

  it("names a missing S-PIN or home location in the support log", async () => {
    const { controller, fetch, log } = setup(
      [],
      settingsFor({ spin: "", home: undefined }),
    );
    fetch.mockImplementation(() =>
      Promise.resolve(mockResponse({ body: loadFixture("combustion") })),
    );
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const summary = log.info.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.startsWith("Supported by the vehicle"));
    expect(summary).toContain("Auxiliary Heating (needs the S-PIN)");
    expect(summary).toContain("Home (needs the home location)");
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

  it("keeps the support log steady when one response leaves support open", async () => {
    const { accessory, controller, fetch, log } = setup([]);
    const full = loadFixture("gasoline-live");
    // Seen on a petrol car: some responses omit the CHARGING_UNSUPPORTED notice.
    const withoutNotice = loadFixture("gasoline-live");
    withoutNotice.errors = (withoutNotice.errors ?? []).filter(
      (error) => error.type !== "CHARGING_UNSUPPORTED",
    );
    fetch
      .mockImplementationOnce(() =>
        Promise.resolve(mockResponse({ body: full })),
      )
      .mockImplementation(() =>
        Promise.resolve(mockResponse({ body: withoutNotice })),
      );
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("Supported by the vehicle: Fuel,"),
    );
    log.info.mockClear();
    await vi.advanceTimersByTimeAsync(2 * 5 * 60_000);
    expect(log.info).not.toHaveBeenCalledWith(
      expect.stringContaining("Supported by the vehicle"),
    );
    expect(accessory.getServiceById(Service.Battery, "fuel")).toBeDefined();
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

  it("answers the controls with no response while the data is stale", async () => {
    const { accessory, controller, fetch, log } = setup([
      mockResponse({ body: loadFixture("enyaq") }),
      ...Array.from({ length: 5 }, () =>
        mockResponse({ status: 503, body: problem(503) }),
      ),
    ]);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const charging = accessory
      .getServiceById(Service.Outlet, "charging")!
      .getCharacteristic(Characteristic.On);
    const preset = accessory
      .getServiceById(Service.Switch, "charging-limit-90")!
      .getCharacteristic(Characteristic.On);
    const temperature = accessory
      .getServiceById(Service.HeaterCooler, "climate")!
      .getCharacteristic(Characteristic.HeatingThresholdTemperature);
    const battery = accessory
      .getServiceById(Service.Battery, "battery")!
      .getCharacteristic(Characteristic.BatteryLevel);
    const doors = accessory
      .getServiceById(Service.ContactSensor, "doors")!
      .getCharacteristic(Characteristic.ContactSensorState);
    expect(await charging.handleGetRequest()).toBe(true);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    const sent = fetch.mock.calls.length;
    await expect(charging.handleGetRequest()).rejects.toBe(-70402);
    await expect(battery.handleGetRequest()).rejects.toBe(-70402);
    await expect(charging.handleSetRequest(false)).rejects.toBe(-70402);
    await expect(preset.handleSetRequest(true)).rejects.toBe(-70402);
    await expect(temperature.handleSetRequest(25)).rejects.toBe(-70402);
    await vi.advanceTimersByTimeAsync(3000);
    expect(
      fetch.mock.calls.slice(sent).filter(([, init]) => init?.method !== "GET"),
    ).toEqual([]);
    // Four blocked changes, one explanation in the log.
    expect(
      log.warn.mock.calls.filter(([message]) =>
        String(message).startsWith("No current vehicle data"),
      ),
    ).toHaveLength(1);
    // Names stay readable, so the Home app keeps them.
    expect(
      await accessory
        .getServiceById(Service.Outlet, "charging")!
        .getCharacteristic(Characteristic.ConfiguredName)
        .handleGetRequest(),
    ).toBe("Charging");
    // Sensors stay readable and show the fault instead.
    expect(await doors.handleGetRequest()).toBe(
      Characteristic.ContactSensorState.CONTACT_DETECTED,
    );

    // The next successful update makes the controls usable again. After five failures the backoff
    // has grown to 30 minutes, so it comes about 100 minutes after the start.
    await vi.advanceTimersByTimeAsync(45 * 60_000);
    expect(await charging.handleGetRequest()).toBe(true);
    await charging.handleSetRequest(false);
    expect(charging.value).toBe(false);
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

  it("keeps all charge limit switches after one update without the operation, removes them after two", async () => {
    // The switches share one feature; one odd update must count once, not once per switch.
    const withoutLimit = () => {
      const body = loadFixture("enyaq");
      body.vehicle.operations = body.vehicle.operations!.filter(
        (o) => o.name !== "setChargingLimit",
      );
      return mockResponse({ body });
    };
    const { accessory, controller } = setup([
      mockResponse({ body: loadFixture("enyaq") }),
      withoutLimit(),
      withoutLimit(),
    ]);
    const switches = () =>
      [80, 90, 100].map(
        (percent) =>
          accessory.getServiceById(
            Service.Switch,
            `charging-limit-${percent}`,
          ) !== undefined,
      );
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(switches()).toEqual([true, true, true]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(switches()).toEqual([false, false, false]);
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

  it("sets the limit of a charge limit switch and turns the others off", async () => {
    const { accessory, controller, fetch } = setup([]);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);

    const on = (percent: number) =>
      accessory
        .getServiceById(Service.Switch, `charging-limit-${percent}`)!
        .getCharacteristic(Characteristic.On);
    await on(100).handleSetRequest(true);

    const commands = fetch.mock.calls.filter(
      ([, init]) => init?.method === "PUT",
    );
    expect(commands).toHaveLength(1);
    expect(JSON.parse(commands[0]![1]!.body as string)).toEqual({
      targetStateOfChargeInPercent: 100,
    });
    expect([on(80).value, on(90).value, on(100).value]).toEqual([
      false,
      false,
      true,
    ]);
    controller.stop();
  });

  it("lists the charge limit switches once in the support log", async () => {
    const { controller, log } = setup([]);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const summary = log.info.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.startsWith("Supported by the vehicle"));
    expect(summary?.match(/Charge Limit Switches/g)).toHaveLength(1);
    controller.stop();
  });

  it("sends nothing for the active switch and turns it back on when switched off", async () => {
    const { accessory, controller, fetch } = setup([]);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);

    const on = accessory
      .getServiceById(Service.Switch, "charging-limit-80")!
      .getCharacteristic(Characteristic.On);
    await on.handleSetRequest(true);
    await on.handleSetRequest(false);
    await vi.advanceTimersByTimeAsync(500);

    expect(on.value).toBe(true);
    expect(
      fetch.mock.calls.filter(([, init]) => init?.method === "PUT"),
    ).toHaveLength(0);
    controller.stop();
  });

  it("shows all switches off for a limit without a switch", async () => {
    const { accessory, controller } = setup(
      [],
      settingsFor({ chargingLimits: [90, 100] }),
    );
    controller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(
      [90, 100].map((percent) =>
        value(
          accessory,
          Service.Switch,
          `charging-limit-${percent}`,
          Characteristic.On,
        ),
      ),
    ).toEqual([false, false]);
    controller.stop();
  });

  it("removes switches for limits that are no longer configured", () => {
    const { accessory, onServicesChanged } = setup(
      [],
      settingsFor({ chargingLimits: [80, 100] }),
      (cached) => {
        cached.addService(
          Service.Switch,
          "Charge Limit 70",
          "charging-limit-70",
        );
        cached.addService(
          Service.Switch,
          "Charge Limit 80",
          "charging-limit-80",
        );
      },
    );
    expect(
      accessory.getServiceById(Service.Switch, "charging-limit-70"),
    ).toBeUndefined();
    expect(
      accessory.getServiceById(Service.Switch, "charging-limit-80"),
    ).toBeDefined();
    expect(onServicesChanged).toHaveBeenCalled();
  });

  it("replaces the charge limit lightbulb of earlier versions", () => {
    const { accessory, log, onServicesChanged } = setup(
      [],
      settingsFor(),
      (cached) => {
        cached.addService(Service.Lightbulb, "Charge Limit", "charging-limit");
      },
    );
    expect(
      accessory.getServiceById(Service.Lightbulb, "charging-limit"),
    ).toBeUndefined();
    expect(log.info).toHaveBeenCalledWith(
      "Replaced the Charge Limit lightbulb with charge limit switches",
    );
    expect(onServicesChanged).toHaveBeenCalled();
  });

  /** Serves the Enyaq fixture with the air conditioning running, and 202 for commands. */
  function runningClimate() {
    const running = loadFixture("enyaq");
    running.vehicle.airConditioning!.state = "HEATING";
    const ctx = setup([]);
    ctx.fetch.mockImplementation((_url, init) =>
      Promise.resolve(
        init?.method === "GET"
          ? mockResponse({ body: running })
          : mockResponse({ status: 202 }),
      ),
    );
    const commands = () =>
      ctx.fetch.mock.calls
        .filter(([, init]) => init?.method === "POST")
        .map(([url, init]) => ({
          path: (url as string).replace(/^.*\/air-conditioning/, ""),
          body: init?.body ? (JSON.parse(init.body as string) as object) : {},
        }));
    return { ...ctx, commands };
  }

  it("restarts a running air conditioning with a new temperature", async () => {
    const { accessory, controller, commands } = runningClimate();
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const threshold = accessory
      .getServiceById(Service.HeaterCooler, "climate")!
      .getCharacteristic(Characteristic.HeatingThresholdTemperature);

    await threshold.handleSetRequest(22);
    await threshold.handleSetRequest(23);
    await vi.advanceTimersByTimeAsync(3000);
    expect(commands().map((command) => command.path)).toEqual(["/stop"]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(commands()).toEqual([
      { path: "/stop", body: {} },
      {
        path: "/start",
        body: expect.objectContaining({
          targetTemperature: { value: 23, unit: "CELSIUS" },
        }) as object,
      },
    ]);
    controller.stop();
  });

  it("drops a waiting temperature change when Homebridge shuts down", async () => {
    const { accessory, controller, commands } = runningClimate();
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const threshold = accessory
      .getServiceById(Service.HeaterCooler, "climate")!
      .getCharacteristic(Characteristic.HeatingThresholdTemperature);

    await threshold.handleSetRequest(23);
    controller.stop();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(commands()).toEqual([]);
  });

  it("does not restart the air conditioning after a shutdown during the pause", async () => {
    const { accessory, controller, commands, log } = runningClimate();
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const threshold = accessory
      .getServiceById(Service.HeaterCooler, "climate")!
      .getCharacteristic(Characteristic.HeatingThresholdTemperature);

    await threshold.handleSetRequest(23);
    await vi.advanceTimersByTimeAsync(3000);
    controller.stop();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(commands().map((command) => command.path)).toEqual(["/stop"]);
    expect(log.info).toHaveBeenCalledWith(
      "Homebridge is shutting down; the air conditioning was not restarted",
    );
  });

  it("does not restart the air conditioning when the data turns stale during the slider delay", async () => {
    // The first poll reports it running; every later poll fails, so the data turns stale after
    // three intervals (15 minutes).
    let polls = 0;
    const { accessory, controller, fetch, log } = setup([]);
    fetch.mockImplementation((_url, init) => {
      if (init?.method !== "GET") {
        return Promise.resolve(mockResponse({ status: 202 }));
      }
      if (polls++ > 0) {
        return Promise.resolve(
          mockResponse({ status: 503, body: problem(503) }),
        );
      }
      const running = loadFixture("enyaq");
      running.vehicle.airConditioning!.state = "HEATING";
      return Promise.resolve(mockResponse({ body: running }));
    });
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const threshold = accessory
      .getServiceById(Service.HeaterCooler, "climate")!
      .getCharacteristic(Characteristic.HeatingThresholdTemperature);

    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1000);
    await threshold.handleSetRequest(23);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(
      fetch.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(
      "No current vehicle data; target temperature 23 °C will be used on the next start",
    );
    controller.stop();
  });

  it("only uses names that HomeKit accepts", async () => {
    // HAP-NodeJS's rule (util/checkName): start and end with a letter or digit, and only some
    // punctuation in between. A name like "Charge Limit 80 %" may stop the Home app from adding
    // the vehicle.
    const valid =
      /^[\p{L}\p{N}][\p{L}\p{N}\p{Zs}\u2019'&!._:;()/,-]*[\p{L}\p{N}]$/u;
    const { accessory, controller } = setup(
      [],
      settingsFor({
        features: {
          stateOfChargeSensor: true,
          activeVentilation: true,
          lights: true,
          windowHeating: true,
          plugLock: true,
          pluggedIn: true,
        },
        chargingLimits: [50, 60, 70, 80, 90, 100],
      }),
    );
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const names = accessory.services.flatMap((service) =>
      [Characteristic.Name, Characteristic.ConfiguredName]
        .filter((name) => service.testCharacteristic(name))
        .map((name) => service.getCharacteristic(name).value as string),
    );
    expect(names.length).toBeGreaterThan(15);
    expect(names.filter((name) => !valid.test(name))).toEqual([]);
    controller.stop();
  });

  it("creates the air conditioning without HAP warnings about its temperature limits", async () => {
    const warnings: unknown[] = [];
    const { controller } = setup([], settingsFor(), (accessory) => {
      (accessory as unknown as hapNodejs.Accessory).on(
        "characteristic-warning",
        (warning) => warnings.push(warning),
      );
    });
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(warnings).toEqual([]);
    controller.stop();
  });

  it("shows the expected state for at most 15 minutes if the vehicle never reports back", async () => {
    // The fixture keeps reporting "charging" with the same timestamp, as if the stop never arrived.
    const { accessory, controller } = setup([]);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const on = accessory
      .getServiceById(Service.Outlet, "charging")!
      .getCharacteristic(Characteristic.On);

    await on.handleSetRequest(false);
    expect(on.value).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(on.value).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(on.value).toBe(true);
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
