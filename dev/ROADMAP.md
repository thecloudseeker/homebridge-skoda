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

## 0.5.0: Charge limit presets, tests and verification

In progress (see the [changelog](../CHANGELOG.md)): one switch per configured limit replaces the
lightbulb. The lightbulb is removed right away instead of after one more release, because 0.5.0 is
still in beta; a config that had turned it off keeps the switches off. It also takes everything
from the former 0.6.0 that needs no vehicle:
stale data on the controls, the split of `VehicleController`, a test with a real saved config,
the missing tests and the clean-ups. What needs a vehicle is in
[Needs a charging vehicle](#needs-a-charging-vehicle).

Open question that needs no vehicle:

- **Does the Home app really offer no automation trigger for _Outlet In Use_?** Answer: try to
  create the automation with any outlet in the Home app. If it does offer one, the "Plugged In"
  sensor is optional.

## 0.6.0: Matter

Homebridge 2 registers Matter accessories through a separate API (`api.matter`) with explicit
device types; HomeKit services are not converted automatically. Register Matter accessories only
when `api.isMatterEnabled()` is true, next to the HomeKit accessory.

| Service                                              | Matter device type                    | Fit                                                                     |
| ---------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------- |
| Contact sensors (body, lights, plug, heating)        | Contact Sensor                        | Clean                                                                   |
| Lock (read-only)                                     | Door Lock                             | Check whether a read-only lock is possible                              |
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

## 0.7.0: Command queue

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

## Needs a charging vehicle

These questions can only be answered with an electric or plug-in hybrid vehicle that charges. No
such vehicle is available for testing at the moment, so they are not tied to a release. Answer
them from the debug log ("Vehicle data updated (notices: …)" and "Reported: …") and adjust the
code in the next release after.

- **What does `plugLockState` report without a cable?** 0.4.0 assumes `UNLOCKED` and ignores the
  lock state while unplugged.
- **How often is a plugged-in cable unlocked while not charging?** With automatic unlocking after
  charging, "Plug Locked" could be open most of the time.
- **Do the charge limit switches work with a real vehicle?** Turn one on and check that the
  vehicle reports the new limit, that the other switches turn off, and that a limit set in the
  MyŠkoda app shows up.
- **Does `carCapturedTimestamp` move after a command, and how quickly?** The plugin keeps the
  expected state until the vehicle's `carCapturedTimestamp` for that part moves past the time of
  the command, for at most 15 minutes. The API documents the timestamp, but it is not confirmed
  with a real electric vehicle that it moves after a command. Compare the "Reported: …" debug
  lines with the info line of each accepted command.
- **Is 15 minutes the right time for the expected state?** Today a command the vehicle accepts but
  does not carry out, for example starting to charge without a cable, shows the wrong state for up
  to 15 minutes. Tune it with the answer above.
- **Measure the other estimated timings:** the two updates before a service is removed, the 10 s
  pause when the air conditioning restarts, and the 3 s delay of the temperature slider. They need
  a vehicle with remote air conditioning and services that come and go.

## Not planned

- **Odometer, range and parking position as HomeKit services.** HomeKit and Matter have no
  fitting device types. The parking position only feeds the "Home" sensor.
- **Window heating as a switch.** The API offers no window heating command, so it stays a
  read-only sensor.
- **Lock and unlock, honk and flash, wake up.** Not offered by the API.
