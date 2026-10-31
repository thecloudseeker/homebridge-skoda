import * as hapNodejs from '@homebridge/hap-nodejs';
import type { API, Characteristic as CharacteristicClass, PlatformAccessory, WithUUID } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VehicleAccessory } from '../src/accessory/vehicleAccessory.js';
import { SkodaApiClient } from '../src/api/client.js';
import { RateBudget } from '../src/api/rateBudget.js';
import { parseVehicleConfig, type VehicleSettings } from '../src/config.js';
import { VehicleController } from '../src/vehicle/vehicleController.js';
import { TEST_TOKEN, TEST_VIN, loadFixture, mockResponse, problem, silentLogger } from './helpers.js';

const hap = hapNodejs as unknown as API['hap'];
const { Characteristic, Service } = hap;

function settingsFor(overrides: Record<string, unknown> = {}): VehicleSettings {
  const result = parseVehicleConfig(
    { name: 'Enyaq', vin: TEST_VIN, token: TEST_TOKEN, spin: '0000', home: { lat: 50.4128, lon: 14.9069 }, ...overrides },
    0,
  );
  if (!result.ok) {
    throw new Error(result.errors.join(', '));
  }
  return result.settings;
}

function setup(responses: Response[], settings = settingsFor()) {
  const queue = [...responses];
  const fetch = vi.fn<typeof globalThis.fetch>((_url, init) =>
    Promise.resolve(
      queue.shift() ??
        (init?.method === 'GET' ? mockResponse({ body: loadFixture('enyaq') }) : mockResponse({ status: 202 })),
    ),
  );
  const client = new SkodaApiClient({ token: TEST_TOKEN, vin: TEST_VIN, budget: new RateBudget(), fetch });
  const log = silentLogger();
  const controller = new VehicleController({
    pollClient: client,
    commandClient: client,
    log,
    pollingIntervalMinutes: settings.pollingIntervalMinutes,
    commandRefreshDelaySeconds: settings.commandRefreshDelaySeconds,
  });
  const accessory = new hapNodejs.Accessory('Enyaq', hap.uuid.generate(TEST_VIN)) as unknown as PlatformAccessory;
  new VehicleAccessory({ hap, accessory, controller, settings, log });
  return { accessory, controller, fetch, log };
}

const value = (accessory: PlatformAccessory, service: typeof Service.Battery, subtype: string, characteristic: WithUUID<new () => CharacteristicClass>) =>
  accessory.getServiceById(service, subtype)?.getCharacteristic(characteristic).value;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('VehicleAccessory', () => {
  it('creates no services before the first poll', () => {
    const { accessory } = setup([]);
    expect(accessory.services.map((s) => s.UUID)).toEqual([Service.AccessoryInformation.UUID]);
  });

  it('creates and fills the services an electric vehicle supports', async () => {
    const { accessory, controller } = setup([]);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);

    const subtypes = accessory.services.map((s) => s.subtype).filter(Boolean);
    expect(subtypes).toEqual([
      'battery',
      'charging',
      'charging-limit',
      'climate',
      'home',
      'doors',
      'windows',
      'trunk',
      'bonnet',
      'lock',
    ]);

    expect(value(accessory, Service.Battery, 'battery', Characteristic.BatteryLevel)).toBe(62);
    expect(value(accessory, Service.Battery, 'battery', Characteristic.ChargingState)).toBe(Characteristic.ChargingState.CHARGING);
    expect(value(accessory, Service.Outlet, 'charging', Characteristic.On)).toBe(true);
    expect(value(accessory, Service.Outlet, 'charging', Characteristic.OutletInUse)).toBe(true);
    expect(value(accessory, Service.Lightbulb, 'charging-limit', Characteristic.Brightness)).toBe(80);
    expect(value(accessory, Service.HeaterCooler, 'climate', Characteristic.Active)).toBe(Characteristic.Active.INACTIVE);
    expect(value(accessory, Service.HeaterCooler, 'climate', Characteristic.CurrentTemperature)).toBe(21.5);
    expect(value(accessory, Service.HeaterCooler, 'climate', Characteristic.HeatingThresholdTemperature)).toBe(21.5);
    expect(value(accessory, Service.OccupancySensor, 'home', Characteristic.OccupancyDetected)).toBe(
      Characteristic.OccupancyDetected.OCCUPANCY_DETECTED,
    );
    expect(value(accessory, Service.OccupancySensor, 'home', Characteristic.StatusFault)).toBe(Characteristic.StatusFault.NO_FAULT);
    expect(value(accessory, Service.ContactSensor, 'lock', Characteristic.ContactSensorState)).toBe(
      Characteristic.ContactSensorState.CONTACT_DETECTED,
    );
    controller.stop();
  });

  it('honours feature toggles', async () => {
    const { accessory, controller } = setup(
      [],
      settingsFor({ features: { climate: false, stateOfChargeSensor: true, activeVentilation: true } }),
    );
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const subtypes = accessory.services.map((s) => s.subtype);
    expect(subtypes).not.toContain('climate');
    expect(subtypes).toContain('state-of-charge');
    expect(subtypes).toContain('active-ventilation');
    expect(value(accessory, Service.HumiditySensor, 'state-of-charge', Characteristic.CurrentRelativeHumidity)).toBe(62);
    controller.stop();
  });

  it('creates the auxiliary heating switch only with an S-PIN', async () => {
    const withPin = setup([mockResponse({ body: loadFixture('combustion') })]);
    withPin.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(withPin.accessory.services.map((s) => s.subtype)).toContain('auxiliary-heating');
    expect(withPin.accessory.services.map((s) => s.subtype)).not.toContain('battery');
    withPin.controller.stop();

    const withoutPin = setup([mockResponse({ body: loadFixture('combustion') })], settingsFor({ spin: '' }));
    withoutPin.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(withoutPin.accessory.services.map((s) => s.subtype)).not.toContain('auxiliary-heating');
    withoutPin.controller.stop();
  });

  it('keeps services while the API is unreachable and flags stale data', async () => {
    const { accessory, controller } = setup([
      mockResponse({ body: loadFixture('enyaq') }),
      ...Array.from({ length: 5 }, () => mockResponse({ status: 503, body: problem(503) })),
    ]);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(accessory.getServiceById(Service.Battery, 'battery')).toBeDefined();
    expect(value(accessory, Service.ContactSensor, 'doors', Characteristic.StatusFault)).toBe(
      Characteristic.StatusFault.GENERAL_FAULT,
    );
    controller.stop();
  });

  it('starts air conditioning with the target temperature', async () => {
    const { accessory, controller, fetch } = setup([]);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);

    const active = accessory.getServiceById(Service.HeaterCooler, 'climate')!.getCharacteristic(Characteristic.Active);
    await active.handleSetRequest(Characteristic.Active.ACTIVE);

    const [url, init] = fetch.mock.calls[1]!;
    expect(url).toMatch(/\/air-conditioning\/start$/);
    expect(JSON.parse(init!.body as string)).toEqual({ targetTemperature: { value: 21.5, unit: 'CELSIUS' } });
    expect(active.value).toBe(Characteristic.Active.ACTIVE);
    controller.stop();
  });

  it('reports a failed command as no response and reverts the switch', async () => {
    const { accessory, controller } = setup([
      mockResponse({ body: loadFixture('enyaq') }),
      mockResponse({ status: 422, body: problem(422, 'operation-disabled') }),
    ]);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);

    const on = accessory.getServiceById(Service.Outlet, 'charging')!.getCharacteristic(Characteristic.On);
    await expect(on.handleSetRequest(false)).rejects.toBe(-70402);
    await vi.advanceTimersByTimeAsync(500);
    expect(on.value).toBe(true);
    controller.stop();
  });

  it('debounces and normalizes the charging limit', async () => {
    const { accessory, controller, fetch } = setup([]);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);

    const brightness = accessory
      .getServiceById(Service.Lightbulb, 'charging-limit')!
      .getCharacteristic(Characteristic.Brightness);
    await brightness.handleSetRequest(60);
    await brightness.handleSetRequest(73);
    await vi.advanceTimersByTimeAsync(3000);

    const commands = fetch.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(commands).toHaveLength(1);
    expect(JSON.parse(commands[0]![1]!.body as string)).toEqual({ targetStateOfChargeInPercent: 70 });
    expect(brightness.value).toBe(70);
    controller.stop();
  });

  it('keeps a started ventilation on while the vehicle still reports OFF', async () => {
    // Observed live: after a 202 for start, polls kept reporting OFF while the ventilation ran.
    const gasoline = loadFixture('gasoline-live');
    const settings = settingsFor({ features: { activeVentilation: true } });
    const { accessory, controller, fetch } = setup([], settings);
    fetch.mockImplementation((_url, init) =>
      Promise.resolve(init?.method === 'GET' ? mockResponse({ body: gasoline }) : mockResponse({ status: 202 })),
    );
    controller.start();
    await vi.advanceTimersByTimeAsync(0);

    const on = accessory.getServiceById(Service.Switch, 'active-ventilation')!.getCharacteristic(Characteristic.On);
    await on.handleSetRequest(true);
    expect(on.value).toBe(true);

    await vi.advanceTimersByTimeAsync(90_000); // follow-up refresh still says OFF
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(2);
    expect(on.value).toBe(true);

    await vi.advanceTimersByTimeAsync(10 * 60_000); // past the reported duration of 600 s
    expect(on.value).toBe(false);
    controller.stop();
  });

  it('drops the held ventilation state on stop', async () => {
    const gasoline = loadFixture('gasoline-live');
    const { accessory, controller, fetch } = setup([], settingsFor({ features: { activeVentilation: true } }));
    fetch.mockImplementation((_url, init) =>
      Promise.resolve(init?.method === 'GET' ? mockResponse({ body: gasoline }) : mockResponse({ status: 202 })),
    );
    controller.start();
    await vi.advanceTimersByTimeAsync(0);

    const on = accessory.getServiceById(Service.Switch, 'active-ventilation')!.getCharacteristic(Characteristic.On);
    await on.handleSetRequest(true);
    await on.handleSetRequest(false);
    expect(on.value).toBe(false);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(on.value).toBe(false);
    controller.stop();
  });

  it('sends the S-PIN with the auxiliary heating but never logs it', async () => {
    const { accessory, controller, fetch, log } = setup([mockResponse({ body: loadFixture('combustion') })], settingsFor({
      spin: '4711',
      auxiliaryHeatingDurationMinutes: 20,
    }));
    controller.start();
    await vi.advanceTimersByTimeAsync(0);

    const on = accessory.getServiceById(Service.Switch, 'auxiliary-heating')!.getCharacteristic(Characteristic.On);
    await on.handleSetRequest(true);
    const [, init] = fetch.mock.calls[1]!;
    expect(JSON.parse(init!.body as string)).toEqual({ spin: '4711', durationInSeconds: 1200 });

    const logged = [...log.debug.mock.calls, ...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls].flat().join('\n');
    expect(logged).not.toContain('4711');
    expect(logged).not.toContain(TEST_TOKEN);
    controller.stop();
  });
});
