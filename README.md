# Homebridge Škoda

[![CI](https://github.com/thecloudseeker/homebridge-skoda/actions/workflows/ci.yml/badge.svg)](https://github.com/thecloudseeker/homebridge-skoda/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-BSD%203--Clause-blue.svg)](LICENSE)

Homebridge plugin that brings Škoda vehicles into Apple Home through the official
[MyŠkoda Public API](https://public.api.connect.skoda-auto.cz/docs): state of charge, charging,
air conditioning, auxiliary heating, "at home" detection, doors, windows and lock state.

> [!IMPORTANT]
> This is **not an official Škoda project**. It is not affiliated with, endorsed by or supported by
> ŠKODA AUTO a.s. "Škoda" and "MyŠkoda" are trademarks of their respective owner.
>
> Škoda provides the MyŠkoda Public API **for personal end-user use only**. Do not use this plugin
> to build or operate commercial products or services.

## Features

Each vehicle becomes one HomeKit accessory. A service is only created if it is enabled in the
config **and** the vehicle reports that it supports it. For the controls, that is the list of
remote operations the API reports for the vehicle. If two updates report a control as no longer
supported, or the vehicle rejects a command as unsupported, the service is removed. A single odd
update or an unreachable API never removes services. If a vehicle's entry in the config becomes invalid, for
example while you replace its API key, the vehicle stays in HomeKit and shows "No Response" until
the entry is fixed.

| HomeKit service                                                  | Shows                                                                      | Controls                                       | Default |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------- | ------- |
| Battery                                                          | State of charge, charging state, low battery below a threshold             | –                                              | on      |
| Humidity sensor "State of Charge"                                | State of charge in %, so you can build automations on it                   | –                                              | off     |
| Battery "Fuel"                                                   | Fuel level, low below the threshold (petrol, diesel, CNG, LPG)             | –                                              | on      |
| Humidity sensor "Fuel Level"                                     | Fuel level in %, so you can build automations on it                        | –                                              | off     |
| Outlet "Charging"                                                | _On_ = charging, _Outlet In Use_ = cable plugged in                        | Start / stop charging                          | on      |
| Switches "Charge Limit 80", "90", "100"                          | On = the vehicle's charging limit                                          | Set charging limit                             | on      |
| Heater Cooler "Climate"                                          | Active, heating / cooling, target temperature                              | Start / stop air conditioning, set temperature | on      |
| Switch "Auxiliary Heating"                                       | Running                                                                    | Start / stop (needs your S-PIN)                | on      |
| Switch "Ventilation"                                             | Running, as far as the vehicle reports it (see notes)                      | Start / stop active ventilation                | off     |
| Occupancy sensor "Home"                                          | Parked within a radius around your home                                    | –                                              | on      |
| Contact sensors "Doors", "Windows", "Trunk", "Bonnet", "Sunroof" | Open / closed                                                              | –                                              | on      |
| Lock "Locked"                                                    | Locked / unlocked                                                          | – (read-only, the API cannot lock or unlock)   | on      |
| Contact sensor "Lights"                                          | Open = lights on                                                           | –                                              | off     |
| Contact sensor "Window Heating"                                  | Open = front or rear window heating on                                     | – (the API has no command for it)              | off     |
| Occupancy sensor "Plugged In"                                    | Detected = charging cable plugged in, for automations                      | –                                              | off     |
| Contact sensor "Plug Locked"                                     | Closed = charging cable locked or no cable; open = plugged in but unlocked | –                                              | off     |

HomeKit has no services for range or mileage, so the plugin does not show them.

What the API does **not** offer, and therefore this plugin neither: locking and unlocking, honking
and flashing, waking the vehicle up, cabin temperature, and push updates.

### HomeKit notes

- **Climate.** The API has no cabin temperature reading, so _Current Temperature_ mirrors the
  target temperature. The API has no heat or cool mode either, so the mode is fixed to _Auto_ and
  both thresholds always hold the same value. Temperatures range from 16 to 29.5 °C in steps of
  0.5 °C. Changing the temperature while the air conditioning is running restarts it (stop,
  10 s pause, start), which costs two requests. While it is off, the new temperature is used on
  the next start.
- **Charge limit.** HomeKit has no control for a percentage setpoint, so each limit gets a switch.
  Turning one on sets that limit and turns the others off. A switch cannot be turned off
  directly, because the vehicle always has a limit. A limit set in the MyŠkoda app that has no
  switch shows all switches off. Choose the limits under `chargingLimits` (50–100 in steps of 10;
  none uses 80, 90 and 100).
  Before 0.5.0 the limit was the brightness of a lightbulb, which scenes and "all lights" commands
  changed by accident. The lightbulb is removed on update.
- **Ventilation.** A ventilation started through the Public API runs, but Škoda does not report it
  as running: in a live test the API said _off_ during the whole 10-minute run, and the MyŠkoda
  app showed it the same way. A ventilation started in the app is reported correctly. The switch
  therefore always shows the reported state: after you switch it on in HomeKit it returns to _off_
  once the vehicle has accepted the start (see the log), and it shows _on_ when the ventilation
  was started in the app.
- **Fuel.** HomeKit has no fuel service, so combustion vehicles show their fuel level as a battery
  that cannot be charged. Low battery uses `lowBatteryThreshold`. Plug-in hybrids keep the
  high-voltage battery in the battery service; their fuel level is available as the "Fuel Level"
  humidity sensor.
- **Lock.** Shown as a lock, so the Home app says _locked_ or _unlocked_. The API cannot lock or
  unlock, so the lock is read-only: changing it in the Home app fails right away, and Siri
  answers "lock all doors" with "no response" for the vehicle.
- **Separate tiles.** The Home app groups the vehicle's controls into one tile. To give the
  ventilation, air conditioning, charging and lock tiles of their own, open the vehicle's settings
  in the Home app and choose _Show as Separate Tiles_. The sensors appear in the room's summary
  either way.
- **Room summary.** The Home app counts the sensors in the room's summary: "Home" and "Plugged In"
  as presence, the "Fuel Level" and "State of Charge" sensors as humidity. Put the vehicle in a
  room of its own, for example "Car", to keep your other rooms' summaries clean.
- **Expected state after a command.** HomeKit shows the expected state right away and keeps it
  until the vehicle reports that part again, at most 15 minutes. If the vehicle reports something
  else, for example because charging could not start, HomeKit shows what the vehicle reports.
- **Stale data.** If the last successful update is older than three polling intervals, the sensors
  show a fault (_StatusFault_). Battery, outlet, switches, the heater cooler and the lock have no
  fault indicator in HomeKit, so they show "No Response" instead and send no commands, until the
  next update succeeds. The same applies after a restart until the first update succeeds: usually
  a few seconds, but as long as the API cannot be reached, or the API key is invalid. The Home app
  never shows an old state of a control as current, and the log says once why commands are not
  sent.

## Requirements

- A connected Škoda vehicle and a MyŠkoda account
- Homebridge 1.8 or 2.x
- Node.js 22, 24 or 26

## Installation

In the Homebridge UI, open **Plugins**, search for `@thecloudseeker/homebridge-skoda` and click
**Install**. Or run this in the Homebridge terminal:

```sh
hb-service add @thecloudseeker/homebridge-skoda
```

Running the plugin as a child bridge is recommended, so problems with the Škoda API never hold up
your other accessories.

A newly configured vehicle appears in HomeKit after the first successful update from the API,
usually a few seconds after Homebridge has started. That way it shows up complete, and the Home app
keeps the names of its sensors. If it does not appear, check the log for an error about the API
key or the VIN.

## Creating an API key

1. Open the **MyŠkoda app** and go to **Profile › Smart Home**. On your phone you can also open
   [go.skoda.eu/api-keys](https://go.skoda.eu/api-keys) directly.
2. Create a new API key and select the vehicle(s) it should cover.
3. Copy the key into the plugin config together with the vehicle's VIN.

Keys are bound to the vehicles you selected and **they expire**. The plugin warns in the log seven
days before a key expires. Once it has expired, the plugin logs an error and retries every hour
(failed authentication does not count against the rate limit). Renew the key in the app and
update the config.

## Configuration

The easiest way is the Homebridge UI. In `config.json` it looks like this:

```json
{
  "platform": "Skoda",
  "vehicles": [
    {
      "name": "Enyaq",
      "vin": "TMBJB9NY5RF999999",
      "token": "<your API key>",
      "home": { "lat": 50.4128, "lon": 14.9069, "radiusMeters": 150 },
      "pollingIntervalMinutes": 5,
      "features": { "stateOfChargeSensor": true }
    }
  ]
}
```

| Option                            | Default                 | Description                                                                                                                                                                                                                                                                        |
| --------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                            | `Škoda <last 4 of VIN>` | Accessory name in HomeKit                                                                                                                                                                                                                                                          |
| `vin`                             | –                       | Vehicle identification number (required)                                                                                                                                                                                                                                           |
| `token`                           | –                       | API key (required)                                                                                                                                                                                                                                                                 |
| `drive`                           | –                       | `electric`, `hybrid` (plug-in) or `combustion` (also mild hybrids). Only hides settings that do not apply in the Homebridge UI; the plugin detects what the vehicle supports either way                                                                                            |
| `spin`                            | –                       | S-PIN, only needed for the auxiliary heating                                                                                                                                                                                                                                       |
| `home.lat`, `home.lon`            | –                       | Home coordinates for the "Home" sensor                                                                                                                                                                                                                                             |
| `home.radiusMeters`               | `150`                   | Radius around home, at least 10 m                                                                                                                                                                                                                                                  |
| `pollingIntervalMinutes`          | `5`                     | Polling interval, at least 4 (see below)                                                                                                                                                                                                                                           |
| `lowBatteryThreshold`             | `20`                    | Low battery below this state of charge or fuel level (%)                                                                                                                                                                                                                           |
| `climateTemperature`              | `21`                    | Cabin temperature (°C) until the vehicle reports one                                                                                                                                                                                                                               |
| `airConditioningOnBattery`        | –                       | `"allow"` or `"deny"` air conditioning from the drive battery when not plugged in; unset keeps the vehicle setting                                                                                                                                                                 |
| `auxiliaryHeatingDurationMinutes` | –                       | Auxiliary heating run time; unset keeps the vehicle setting                                                                                                                                                                                                                        |
| `chargingLimits`                  | `[80, 90, 100]`         | Charging limits (%) that get a switch, 50–100 in steps of 10                                                                                                                                                                                                                       |
| `features.*`                      | see table above         | `battery`, `stateOfChargeSensor`, `fuelLevel`, `fuelLevelSensor`, `charging`, `chargingLimitPresets`, `climate`, `auxiliaryHeating`, `activeVentilation`, `presence`, `doors`, `windows`, `trunk`, `bonnet`, `sunroof`, `lock`, `lights`, `windowHeating`, `plugLock`, `pluggedIn` |

## Rate limit

The MyŠkoda Public API currently allows **20 requests per hour per vehicle**. Škoda says this value
is not final, so the plugin follows the `RateLimit-*` headers of every response. Every request
counts, including commands and failed requests with server errors.

The plugin is built around that limit:

- **One request per update.** A single call returns all vehicle data.
- **HomeKit never triggers requests.** Opening the Home app reads from the plugin's cache.
- **Four requests per hour stay free** for commands. That makes 4 minutes the shortest polling
  interval; shorter values are raised with a warning. The default of 5 minutes uses 12 requests
  per hour and leaves 8 for commands. The log shows this split at startup.
- **A command costs one request.** The vehicle reports new state with a delay, so instead of an
  extra refresh the plugin keeps the expected state until a regular update carries the vehicle's
  new report.
- **When the budget is used up**, commands are rejected ("No Response" in the Home app) instead of
  being sent, and polling waits until requests are available again.
- **Errors back off.** On `429` and `503` the plugin waits for `Retry-After`. On other server and
  network errors it waits one polling interval, then doubles the wait up to 30 minutes.

Vehicles report their state on their own schedule, so data can be older than the polling interval
suggests, and a command may take a minute or two to show up.

## Privacy and security

- API keys and the S-PIN are never written to the log. The VIN is shortened to its last four
  characters (`…9999`).
- The Homebridge UI shows the keys and the S-PIN as password fields. They are still stored in
  plain text in Homebridge's `config.json`, like all plugin settings. Protect that file.
- The plugin talks only to `public.api.connect.skoda-auto.cz`.

## Troubleshooting

| Log message                                            | Meaning                                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| `The API key has expired`                              | Create or renew a key in the MyŠkoda app and update the config       |
| `The API key does not cover this vehicle or operation` | The key was created for another vehicle, or the VIN is wrong         |
| `No vehicle found for the configured VIN`              | Check the VIN                                                        |
| `rate limit budget exhausted`                          | Too many commands in the last hour; try again later                  |
| `the vehicle declined the request`                     | The vehicle refused for now (e.g. low 12 V battery); try again later |
| `this function is currently disabled for the vehicle`  | Enable the service for the vehicle in the MyŠkoda app                |
| `The vehicle does not support …`                       | The vehicle rejected the command; its control is removed             |

## Development

```sh
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

The tests mock the API completely and contain no real keys or vehicle data.

Upstream changes worth following (the API, the Python library and the Home Assistant integration)
are listed in [dev/MAINTAINING.md](dev/MAINTAINING.md), planned releases in
[dev/ROADMAP.md](dev/ROADMAP.md).

## License

[BSD 3-Clause](LICENSE)
