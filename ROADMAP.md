# Roadmap

Planned releases, based on an audit of 0.3.0 against the planned feature set. Each item is meant
to fit into one pull request. Order within a release is the suggested order of work.

Upstream changes (API, skoda-public-api, Home Assistant) are tracked separately in
[MAINTAINING.md](MAINTAINING.md) and may reorder this list. One question is tracked there rather
than in a release:

- **Will the API add an availability state to the operations list?** The specification says
  fields such as the current availability of an operation may be added later. Today an operation
  can be listed but still be rejected, for example in workshop mode.

Each release lists the questions that have to be answered before or during its work.

## 0.4.0: Safer config handling and automations

- **Keep the vehicle when its config entry is invalid.** Today an entry that fails to parse, for
  example an empty API key while a key is being replaced, is skipped, and its cached accessory is
  unregistered. That removes the vehicle from HomeKit with its rooms, names and automations.
  - If the entry still has a valid VIN, keep the cached accessory, log an error and do not poll.
  - Only unregister vehicles whose VIN is no longer in the config at all.
  - Test: a cached vehicle with an empty key stays registered. (`src/platform.ts`)
- **"Plugged In" sensor for automations.** The cable state is only shown as _Outlet In Use_ on the
  charging outlet, which the Home app does not offer as an automation trigger (see open questions).
  - Add an optional contact sensor `features.pluggedIn`: _open_ = cable plugged in, from
    `charging.status.plugConnectionState`.
  - Create it only for vehicles that support charging. A contact sensor also maps to Matter.
- **Plug Locked only while connected.** Without a cable the vehicle most likely reports
  `UNLOCKED`, so the sensor would show _open_ after every unplug.
  - Report _open_ only while `plugConnectionState` is `CONNECTED`, _closed_ otherwise.
  - Verify with a vehicle that charges before release.
- **Name the real cause in the support log.** Without an S-PIN or home location, auxiliary heating
  and the "Home" sensor are turned off automatically, but the log points to the feature switch
  (`features.auxiliaryHeating`, `features.presence`). Name the missing S-PIN or home location
  instead.

Open questions:

- **Does the settings form look right in the real Homebridge UI?** Number fields instead of
  sliders, the three-way choice for air conditioning when not plugged in, and the note at the top.
  Answer: open the plugin settings in a Homebridge with the current release.
- **Does the Home app really offer no automation trigger for _Outlet In Use_?** Answer: try to
  create the automation in the Home app. If it does offer one, the "Plugged In" sensor is optional.
- **What does `plugLockState` report without a cable?** Answer: debug log from a vehicle that
  charges.

## 0.5.0: Charge limit presets

- **Replace the charge limit lightbulb.** As a lightbulb, the charge limit reacts to scenes and
  "all lights" commands: setting room lights to 30 % sends a real charge limit change (rounded to
  50 %), and "turn off the lights" seems to work but is reverted after half a second. In Matter it
  would be a dimmable light in the same groups.
  - Offer mutually exclusive preset switches, for example 80, 90 and 100 %, configurable within
    50–100 % in steps of 10. Switching one on sends the limit and turns the others off.
  - Switches cannot be turned off directly; turning the active one off is reverted.
  - The presets show the reported limit; a limit set in the MyŠkoda app that matches no preset
    shows all presets off.
  - Keep the lightbulb behind a setting for one release, then remove it.

## 0.6.0: Tests and verification

- **Close test gaps:**
  - the air conditioning restart when the temperature changes while running (stop, 10 s pause,
    start, two requests)
  - unregistering a vehicle that was removed from the config
  - turning the charge limit off (until 0.5.0 removes it)
  - the 15-minute limit of the expected state, seen from the accessory
  - add a coverage report to CI
- **Verify the expected state after commands.** The plugin keeps the expected state until the
  vehicle's `carCapturedTimestamp` for that part moves past the time of the command, for at most
  15 minutes. The API documents the timestamp, but it is not confirmed with a real electric
  vehicle that it moves after a command.
  - Log the timestamps before and after each command at debug level, and collect results from
    users with electric vehicles.
  - Tune the 15 minutes. Today a command the vehicle accepts but does not carry out, for example
    starting to charge without a cable, shows the wrong state for up to 15 minutes.

Open questions:

- **Does `carCapturedTimestamp` move after a command, and how quickly?** Answer: the debug log
  above, from users with electric vehicles.

## 0.7.0: Matter

Homebridge 2 registers Matter accessories through a separate API (`api.matter`) with explicit
device types; HomeKit services are not converted automatically. Register Matter accessories only
when `api.isMatterEnabled()` is true, next to the HomeKit accessory.

| Service                                              | Matter device type                    | Fit                                                                     |
| ---------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------- |
| Contact sensors (body, lock, lights, plug, heating)  | Contact Sensor                        | Clean                                                                   |
| "Home"                                               | Occupancy Sensor                      | Clean                                                                   |
| Charging                                             | On/Off Plug-in Unit (`OnOffOutlet`)   | Clean                                                                   |
| Air conditioning                                     | Thermostat (heating and cooling)      | Mostly: there is no cabin temperature, and the mode is always automatic |
| Ventilation, auxiliary heating, charge limit presets | open (see below)                      | Matter's _On/Off Switch_ is a controller, not a switchable device       |
| Battery, fuel level                                  | _Power Source_ cluster on the vehicle | No standalone device type                                               |
| State of charge and fuel level as humidity sensors   | Humidity Sensor                       | Works, but shows as humidity; probably keep HomeKit-only                |

- **Matter spike** for the clean mappings: contact sensors, "Home", charging and the thermostat.
- **Battery and fuel level** through the _Power Source_ cluster.
- **Decide the switches** (ventilation, auxiliary heating, charge limit presets) once the
  question below is answered.

Open questions:

- **Which Matter device type fits a function you can switch, like ventilation or a charge limit
  preset?** Answer: Homebridge's Matter documentation and a test with the Home app.

## 0.8.0: Command queue

Today a command that does not fit into the request budget is rejected right away ("No Response"
in the Home app), so it never runs unexpectedly later. A queue would send it as soon as a request
is free.

- Queue commands only for a limited time, for example 10 minutes, then drop them with a log
  message.
- Merge commands for the same function: start followed by stop cancels both, and only the latest
  charge limit or temperature is sent.
- Show the expected state while a command waits, and revert it when the command is dropped.
- Commands go before polls; polls keep the reserve rules of the request budget.
- Do not keep the queue across restarts.

Open questions:

- **Is it acceptable that the first request after a restart is always sent, even if the hour's
  quota is already used up?** After a restart the request budget starts empty; if the quota is
  used up, that request gets a `429`, and the server's rate limit headers correct the budget right
  after. Answer: decide whether the budget should be saved across restarts.

## Not planned

- **Odometer, range and parking position as HomeKit services.** HomeKit and Matter have no
  fitting device types. The parking position only feeds the "Home" sensor.
- **Window heating as a switch.** The API offers no window heating command, so it stays a
  read-only sensor.
- **Lock and unlock, honk and flash, wake up.** Not offered by the API.
