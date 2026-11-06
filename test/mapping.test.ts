import { describe, expect, it } from "vitest";
import type { Vehicle } from "../src/api/types.js";
import {
  batteryValues,
  bodyValues,
  chargingLimit,
  climateValues,
  fuelLevel,
  fuelValues,
  isActiveVentilationOn,
  isAtHome,
  isAuxiliaryHeatingOn,
  isCharging,
  isPlugConnected,
  isPlugLocked,
  isWindowHeatingOn,
  stateOfCharge,
  toCelsius,
} from "../src/vehicle/mapping.js";
import {
  featureSupport,
  mergeSnapshot,
  type VehicleSnapshot,
} from "../src/vehicle/snapshot.js";
import { describeReport } from "../src/vehicle/mapping.js";
import { loadFixture, TEST_VIN } from "./helpers.js";

const enyaq = loadFixture("enyaq");
const combustion = loadFixture("combustion");

const snapshotOf = (response = enyaq): VehicleSnapshot =>
  mergeSnapshot(undefined, response, 0);

const withCharging = (
  status: NonNullable<Vehicle["charging"]>["status"],
): Vehicle => ({
  charging: { isVehicleInSavedLocation: false, status },
});

describe("battery mapping", () => {
  it("maps state of charge, charging and low battery", () => {
    expect(batteryValues(enyaq.vehicle, 20)).toEqual({
      level: 62,
      charging: true,
      low: false,
    });
    expect(batteryValues(enyaq.vehicle, 70)).toMatchObject({ low: true });
  });

  it("is unknown without charging data", () => {
    expect(batteryValues(combustion.vehicle, 20)).toEqual({
      level: undefined,
      charging: undefined,
      low: undefined,
    });
  });

  it("falls back to the electric engine range of a plug-in hybrid", () => {
    const vehicle: Vehicle = {
      fuelStatus: {
        primaryEngineRange: {
          engineType: "GASOLINE",
          currentFuelLevelInPercent: 40,
        },
        secondaryEngineRange: {
          engineType: "ELECTRIC",
          currentSoCInPercent: 33.4,
        },
      },
    };
    expect(stateOfCharge(vehicle)).toBe(33);
  });

  it("clamps out-of-range values", () => {
    expect(
      stateOfCharge(withCharging({ battery: { stateOfChargeInPercent: 104 } })),
    ).toBe(100);
  });
});

describe("charging outlet mapping", () => {
  it.each([
    ["CHARGING", true],
    ["CONSERVING", false],
    ["READY_FOR_CHARGING", false],
    ["CONNECT_CABLE", false],
    ["CHARGING_INTERRUPTED", false],
    ["SOMETHING_NEW", undefined],
    [undefined, undefined],
  ])("state %s → charging %s", (state, expected) => {
    expect(isCharging(withCharging({ state }))).toBe(expected);
  });

  it("prefers the reported plug state", () => {
    expect(
      isPlugConnected(
        withCharging({
          plugConnectionState: "CONNECTED",
          state: "CONNECT_CABLE",
        }),
      ),
    ).toBe(true);
    expect(
      isPlugConnected(withCharging({ plugConnectionState: "DISCONNECTED" })),
    ).toBe(false);
  });

  it("derives the plug state from the charging state", () => {
    expect(isPlugConnected(withCharging({ state: "CONNECT_CABLE" }))).toBe(
      false,
    );
    expect(isPlugConnected(withCharging({ state: "READY_FOR_CHARGING" }))).toBe(
      true,
    );
    // Omitted state never means disconnected.
    expect(isPlugConnected(withCharging({}))).toBeUndefined();
  });
});

describe("charging limit mapping", () => {
  it("reads the target state of charge", () => {
    expect(chargingLimit(enyaq.vehicle)).toBe(80);
    expect(chargingLimit(combustion.vehicle)).toBeUndefined();
  });
});

describe("climate mapping", () => {
  it.each([
    ["OFF", false, "INACTIVE"],
    ["COMPLETED", false, "INACTIVE"],
    ["HEATING", true, "HEATING"],
    ["HEATING_AUXILIARY", true, "HEATING"],
    ["COOLING", true, "COOLING"],
    ["VENTILATION", true, "IDLE"],
    ["UNKNOWN", undefined, undefined],
    ["UNSUPPORTED", undefined, undefined],
  ])("state %s → active %s, mode %s", (state, active, mode) => {
    expect(climateValues({ airConditioning: { state } })).toMatchObject({
      active,
      mode,
    });
  });

  it("reads the target temperature and converts Fahrenheit", () => {
    expect(climateValues(enyaq.vehicle).targetCelsius).toBe(21.5);
    expect(toCelsius({ value: 70, unit: "FAHRENHEIT" })).toBeCloseTo(21.11, 2);
    expect(toCelsius(undefined)).toBeUndefined();
  });

  it("maps auxiliary heating and active ventilation", () => {
    expect(isAuxiliaryHeatingOn(combustion.vehicle)).toBe(false);
    expect(
      isAuxiliaryHeatingOn({
        auxiliaryHeating: { state: "HEATING_AUXILIARY" },
      }),
    ).toBe(true);
    expect(
      isAuxiliaryHeatingOn({ auxiliaryHeating: { state: "UNKNOWN" } }),
    ).toBeUndefined();
    expect(isActiveVentilationOn(enyaq.vehicle)).toBe(false);
    expect(
      isActiveVentilationOn({ activeVentilation: { state: "VENTILATION" } }),
    ).toBe(true);
  });
});

describe("presence mapping", () => {
  const home = { latitude: 50.4128, longitude: 14.9069, radiusMeters: 150 };

  it("is at home when parked within the radius", () => {
    expect(isAtHome(enyaq.vehicle, home)).toBe(true);
  });

  it("is away when parked outside the radius", () => {
    expect(isAtHome(enyaq.vehicle, { ...home, latitude: 50.5 })).toBe(false);
  });

  it("is away while in motion", () => {
    expect(isAtHome(combustion.vehicle, home)).toBe(false);
  });

  it("is unknown without a position", () => {
    expect(isAtHome({}, home)).toBeUndefined();
    expect(
      isAtHome({ parkingPosition: { state: "PARKED" } }, home),
    ).toBeUndefined();
  });
});

describe("body mapping", () => {
  it("maps closed and locked", () => {
    expect(bodyValues(enyaq.vehicle)).toEqual({
      doorsOpen: false,
      windowsOpen: false,
      trunkOpen: false,
      bonnetOpen: false,
      sunroofOpen: undefined,
      locked: true,
      lightsOn: false,
    });
  });

  it("maps open and unlocked, with unknown values left out", () => {
    expect(bodyValues(combustion.vehicle)).toEqual({
      doorsOpen: true,
      windowsOpen: undefined,
      trunkOpen: true,
      bonnetOpen: undefined,
      sunroofOpen: true,
      locked: false,
      lightsOn: false,
    });
  });

  it("maps the lights", () => {
    const vehicle = structuredClone(enyaq.vehicle);
    vehicle.status!.overall.lights = "ON";
    expect(bodyValues(vehicle).lightsOn).toBe(true);
    vehicle.status!.overall.lights = "UNKNOWN";
    expect(bodyValues(vehicle).lightsOn).toBeUndefined();
  });

  it("falls back to `locked` when reliableLockStatus is unknown", () => {
    const vehicle = structuredClone(enyaq.vehicle);
    vehicle.status!.overall.reliableLockStatus = "UNKNOWN";
    vehicle.status!.overall.locked = "NO";
    expect(bodyValues(vehicle).locked).toBe(false);
  });
});

describe("window heating and plug lock mapping", () => {
  it("is on while the front or rear window heating runs", () => {
    const vehicle = structuredClone(enyaq.vehicle);
    expect(isWindowHeatingOn(vehicle)).toBe(false);
    vehicle.airConditioning!.windowHeating = { front: "OFF", rear: "ON" };
    expect(isWindowHeatingOn(vehicle)).toBe(true);
    vehicle.airConditioning!.windowHeating = {
      front: "UNKNOWN",
      rear: "UNSUPPORTED",
    };
    expect(isWindowHeatingOn(vehicle)).toBeUndefined();
  });

  it("maps the plug lock state", () => {
    const vehicle = structuredClone(enyaq.vehicle);
    expect(isPlugLocked(vehicle)).toBe(true);
    vehicle.charging!.status!.plugLockState = "UNLOCKED";
    expect(isPlugLocked(vehicle)).toBe(false);
    delete vehicle.charging!.status!.plugLockState;
    expect(isPlugLocked(vehicle)).toBeUndefined();
  });
});

describe("fuel mapping", () => {
  it("reads the combustion fuel level and flags it low below the threshold", () => {
    expect(fuelLevel(combustion.vehicle)).toBe(65);
    expect(fuelValues(combustion.vehicle, 20)).toEqual({
      level: 65,
      low: false,
    });
    expect(fuelValues(combustion.vehicle, 70)).toEqual({
      level: 65,
      low: true,
    });
  });

  it("ignores the electric range of a hybrid and a missing fuel level", () => {
    const vehicle: Vehicle = {
      fuelStatus: {
        carType: "HYBRID",
        primaryEngineRange: { engineType: "ELECTRIC", currentSoCInPercent: 40 },
        secondaryEngineRange: {
          engineType: "GASOLINE",
          currentFuelLevelInPercent: 55.4,
        },
      },
    };
    expect(fuelLevel(vehicle)).toBe(55);
    expect(fuelLevel(enyaq.vehicle)).toBeUndefined();
    expect(fuelLevel({ fuelStatus: { carType: "GASOLINE" } })).toBeUndefined();
  });
});

describe("feature support", () => {
  it("detects what an electric vehicle offers", () => {
    const snapshot = snapshotOf(enyaq);
    expect(featureSupport(snapshot, "battery")).toBe(true);
    expect(featureSupport(snapshot, "charging")).toBe(true);
    expect(featureSupport(snapshot, "chargingLimitPresets")).toBe(true);
    expect(featureSupport(snapshot, "climate")).toBe(true);
    expect(featureSupport(snapshot, "auxiliaryHeating")).toBe(false);
    expect(featureSupport(snapshot, "activeVentilation")).toBe(true);
    expect(featureSupport(snapshot, "presence")).toBe(true);
    expect(featureSupport(snapshot, "sunroof")).toBe(false);
    expect(featureSupport(snapshot, "lock")).toBe(true);
    expect(featureSupport(snapshot, "lights")).toBe(true);
    expect(featureSupport(snapshot, "windowHeating")).toBe(true);
    expect(featureSupport(snapshot, "plugLock")).toBe(true);
    expect(featureSupport(snapshot, "pluggedIn")).toBe(true);
    expect(featureSupport(snapshot, "fuelLevel")).toBe(false);
    expect(featureSupport(snapshot, "fuelLevelSensor")).toBe(false);
  });

  it("detects what a combustion vehicle offers", () => {
    const snapshot = snapshotOf(combustion);
    expect(featureSupport(snapshot, "battery")).toBe(false);
    expect(featureSupport(snapshot, "charging")).toBe(false);
    expect(featureSupport(snapshot, "auxiliaryHeating")).toBe(true);
    expect(featureSupport(snapshot, "windows")).toBe(false);
    expect(featureSupport(snapshot, "sunroof")).toBe(true);
    expect(featureSupport(snapshot, "fuelLevel")).toBe(true);
    expect(featureSupport(snapshot, "fuelLevelSensor")).toBe(true);
    expect(featureSupport(snapshot, "windowHeating")).toBe(false);
    expect(featureSupport(snapshot, "plugLock")).toBe(false);
    expect(featureSupport(snapshot, "pluggedIn")).toBe(false);
  });

  it("treats window heating without front and rear support as unsupported", () => {
    const vehicle = structuredClone(enyaq);
    vehicle.vehicle.airConditioning!.windowHeating = {
      front: "UNSUPPORTED",
      rear: "UNSUPPORTED",
    };
    expect(featureSupport(snapshotOf(vehicle), "windowHeating")).toBe(false);
    vehicle.vehicle.airConditioning!.windowHeating = { front: "UNKNOWN" };
    expect(
      featureSupport(snapshotOf(vehicle), "windowHeating"),
    ).toBeUndefined();
  });

  it("keeps the plug lock unknown while the vehicle reports no value", () => {
    const vehicle = structuredClone(enyaq);
    delete vehicle.vehicle.charging!.status!.plugLockState;
    expect(featureSupport(snapshotOf(vehicle), "plugLock")).toBeUndefined();
  });

  it("shows the fuel level of a hybrid only as a sensor", () => {
    const hybrid = structuredClone(enyaq);
    hybrid.vehicle.fuelStatus = {
      carType: "HYBRID",
      primaryEngineRange: {
        engineType: "GASOLINE",
        currentFuelLevelInPercent: 50,
      },
    };
    hybrid.errors = [];
    const snapshot = snapshotOf(hybrid);
    expect(featureSupport(snapshot, "battery")).toBe(true);
    expect(featureSupport(snapshot, "fuelLevel")).toBe(false);
    expect(featureSupport(snapshot, "fuelLevelSensor")).toBe(true);
  });

  it("is unknown while parts are unavailable", () => {
    const snapshot = snapshotOf({
      vehicle: { vin: enyaq.vehicle.vin },
      errors: [
        { type: "CHARGING_UNAVAILABLE" },
        { type: "OPERATIONS_UNAVAILABLE" },
        { type: "VEHICLE_STATUS_UNAVAILABLE" },
      ],
    });
    expect(featureSupport(snapshot, "battery")).toBeUndefined();
    expect(featureSupport(snapshot, "charging")).toBeUndefined();
    expect(featureSupport(snapshot, "doors")).toBeUndefined();
    expect(featureSupport(snapshot, "fuelLevel")).toBeUndefined();
  });
});

describe("mergeSnapshot", () => {
  it("keeps temporarily unavailable parts from the previous snapshot", () => {
    const previous = mergeSnapshot(undefined, enyaq, 1);
    const next = mergeSnapshot(
      previous,
      {
        vehicle: { vin: enyaq.vehicle.vin, odometer: { mileageInKm: 1 } },
        errors: [{ type: "CHARGING_UNAVAILABLE" }],
      },
      2,
    );
    expect(next.vehicle.charging).toEqual(enyaq.vehicle.charging);
    expect(next.vehicle.odometer).toEqual({ mileageInKm: 1 });
    expect(next.vehicle.status).toBeUndefined();
    expect(next.fetchedAt).toBe(2);
  });
});

describe("anonymized live response of a gasoline vehicle", () => {
  const live = loadFixture("gasoline-live");
  const snapshot = snapshotOf(live);

  it("offers fuel level, body sensors, presence and active ventilation", () => {
    const supported = (
      [
        "battery",
        "stateOfChargeSensor",
        "fuelLevel",
        "fuelLevelSensor",
        "charging",
        "chargingLimitPresets",
        "climate",
        "auxiliaryHeating",
        "activeVentilation",
        "presence",
        "doors",
        "windows",
        "trunk",
        "bonnet",
        "sunroof",
        "lock",
        "lights",
        "windowHeating",
        "plugLock",
        "pluggedIn",
      ] as const
    ).filter((feature) => featureSupport(snapshot, feature));
    expect(supported).toEqual([
      "fuelLevel",
      "fuelLevelSensor",
      "activeVentilation",
      "presence",
      "doors",
      "windows",
      "trunk",
      "bonnet",
      "sunroof",
      "lock",
      "lights",
    ]);
  });

  it("ignores the state of charge the API reports for a gasoline engine", () => {
    // The real API sends currentSoCInPercent: 100 for engineType GASOLINE.
    expect(
      live.vehicle.fuelStatus?.primaryEngineRange?.currentSoCInPercent,
    ).toBe(100);
    expect(stateOfCharge(live.vehicle)).toBeUndefined();
  });

  it("maps the closed and locked body", () => {
    expect(bodyValues(live.vehicle)).toEqual({
      doorsOpen: false,
      windowsOpen: false,
      trunkOpen: false,
      bonnetOpen: false,
      sunroofOpen: false,
      locked: true,
      lightsOn: false,
    });
    expect(isActiveVentilationOn(live.vehicle)).toBe(false);
  });
});

describe("ventilation started in the MyŠkoda app (observed live)", () => {
  it("maps the reported VENTILATION state to on", () => {
    const live = loadFixture("gasoline-live");
    live.vehicle.activeVentilation = {
      state: "VENTILATION",
      durationInSeconds: 600,
    };
    expect(isActiveVentilationOn(live.vehicle)).toBe(true);
  });
});

describe("debug report", () => {
  it("lists the charging and climate values with their capture times, without VIN or position", () => {
    const { vehicle } = loadFixture("enyaq");
    const report = describeReport(vehicle);
    expect(report).toMatch(/^charging state=\S+ cable=\S+/);
    expect(report).toContain("plugLock=");
    expect(report).toContain("airConditioning state=");
    expect(report).not.toContain(TEST_VIN);
    expect(report).not.toMatch(/latitude|longitude|gps/i);
  });

  it("leaves out parts the vehicle did not report", () => {
    expect(describeReport({})).toBe("nothing");
    expect(
      describeReport({
        charging: {
          isVehicleInSavedLocation: false,
          status: {
            plugConnectionState: "DISCONNECTED",
            plugLockState: "UNLOCKED",
          },
          carCapturedTimestamp: "2026-11-03T10:00:00Z",
        },
      }),
    ).toBe(
      "charging cable=DISCONNECTED plugLock=UNLOCKED captured=2026-11-03T10:00:00Z",
    );
  });
});
