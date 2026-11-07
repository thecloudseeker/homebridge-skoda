# Changelog

## 0.5.0-beta.2

- **Fixed:** the charge limit switches had names like "Charge Limit 80 %". HomeKit does not allow "%" in names, and HAP-NodeJS warned that the Home app might not add the vehicle or stop responding. They are now called "Charge Limit 80", "Charge Limit 90" and so on.
- **Fixed:** a single update without the charge limit operation removed one of the charge limit switches, with its room and automations. A service is again removed only after two such updates, also when several switches share one feature.
- **Fixed:** the stale data check now covers the lock too, and also applies after a restart until the first update succeeds. That takes longer while the API cannot be reached or the API key is invalid. The log says once why commands from HomeKit are not sent.
- **Fixed:** if the data turned stale while a temperature change waited, the air conditioning was stopped but not started again. It now keeps running, and the new temperature is used on the next start.
- **Fixed:** for a part the API reports as temporarily unavailable, the plugin kept the last shown value, which could still be the expected state of a command. That state could then outlast its 15 minutes. It now falls back to what the vehicle last reported.
- **Fixed:** with remote air conditioning, HAP-NodeJS warned on every start that the temperature thresholds had an illegal value (0 and 10 °C, below the 16 °C minimum).
- If you had turned off the charge limit lightbulb with `features.chargingLimit: false`, the charge limit switches stay off too. The settings show them as on, so the log explains how to keep them off until `chargingLimitPresets` is set.
- The drive selection names mild hybrids under "Combustion", as they have no charging socket and the API reports them as combustion vehicles.
- A test checks every name against HomeKit's naming rules. Development tools: rimraf 6.1.4.

## 0.5.0-beta.1

- **Charge limit switches** replace the charge limit lightbulb: one switch per limit, by default 80, 90 and 100 % (`chargingLimits`, 50–100 in steps of 10). Turning one on sets that limit and turns the others off. As a lightbulb, the limit was changed by scenes and "all lights" commands, for example to 50 % when the room lights were dimmed.
- **The lightbulb is removed** on update, and `features.chargingLimit` is no longer used. Automations that used it need to be set up again with the switches.
- **Stale data on the controls:** if the last successful update is older than three polling intervals, the battery, the outlet, the switches and the heater cooler show "No Response" and send no commands, until the next update succeeds. Before, they kept their last state without any hint; only the sensors showed a fault.
- When Homebridge shuts down, a temperature change that is still waiting is dropped, and a running air conditioning is not restarted halfway.
- The request budget gives back the right slot when a response does not count (401, 403, 429). Before, it gave back the newest one, which could shift the request count by a few seconds.
- Tests for the air conditioning restart, for the expected state that is kept at most 15 minutes, and with a config as the settings form really saved it. CI reports the test coverage.
- Internal: the expected state after commands and the log texts for errors moved out of the vehicle controller into their own modules.

## 0.4.0

- **"Locked" is now a lock**, so the Home app says _locked_ or _unlocked_ instead of _closed_ or _open_. It is read-only: changing it in the Home app fails right away. The contact sensor of 0.3.x is replaced, so automations that used it need to be set up again.
- **"Plugged In" sensor** for automations: an optional occupancy sensor that detects a plugged-in charging cable (`features.pluggedIn`). The cable state on the charging outlet (_Outlet In Use_) cannot trigger automations in the Home app.
- **Drive selection in the settings** (`drive`: electric, plug-in hybrid or combustion). It hides settings that do not apply, for example charging for a combustion vehicle or fuel level for an electric one. It only changes the settings form; the plugin still detects what the vehicle supports.
- **Renaming a vehicle** in the config now renames it in Homebridge and HomeKit, on Homebridge 1.8 and 2. Before, a vehicle kept the name it had when it was first added. The Home app may keep a name you set there yourself.
- **Fixed:** a vehicle whose config entry became invalid, for example with an empty API key while the key was being replaced, was removed from HomeKit with its rooms, names and automations. If the entry still has a valid VIN, the vehicle now stays in HomeKit and shows "No Response" until the entry is fixed; the log says so.
- **Fixed:** with the option from before 0.3.1 still in the config, the settings showed "Keep the vehicle's setting" for "Air conditioning when not plugged in" while the old value applied, and the reminder in the log could not be cleared by choosing the option shown. The field is now empty until you choose, and the log names the value that applies.
- **Fixed:** "Plug Locked" no longer shows _open_ while no cable is plugged in. Without a cable the vehicle reports the plug as unlocked, which would trigger an alert after every unplug.
- **Fixed:** the log line listing what the vehicle supports could drop "Fuel" and add it back every few updates, because some responses leave out the notice that the vehicle has no charging. The line now keeps the last known answer. The service itself was never affected.
- The log line listing what the vehicle supports names a missing S-PIN or home location, instead of the feature switch, for auxiliary heating and the "Home" sensor.
- When the vehicle declines a command, the log mentions a low 12 V battery as a possible cause, as the API documentation does.
- **Debug log:** each update logs the API's partial-data notices (for example `CHARGING_UNSUPPORTED`) and what the vehicle reported for charging (state, cable, plug lock, limit, automatic unlock), air conditioning, auxiliary heating, ventilation and the lock, each with the time the vehicle captured it. No VIN, no position. This helps answer open questions with electric vehicles.
- The README explains the room summary and _Show as Separate Tiles_ in the Home app.

## 0.3.1

- **Fixed:** after updating to 0.3.0, the settings form could mark the config as invalid. The option for air conditioning when not plugged in used to be a checkbox; the 0.3.0 form turned its saved value into the text `"false"` or `"true"`, which the new choice does not accept, and the plugin then ignored it. The option now has a new name, `airConditioningOnBattery` (`"vehicle"`, `"allow"` or `"deny"`). The old `airConditioningWithoutExternalPower` is still read in every form until you choose the option again in the settings; the log reminds you once per start.

## 0.3.0

- **Window heating** as an optional read-only contact sensor, open while the front or rear window heating is on (`features.windowHeating`). The API has no command for it.
- **Charging plug lock** as an optional contact sensor, closed while the cable is locked (`features.plugLock`).
- **Clearer settings in the Homebridge UI.** Settings are grouped by topic, each next to the feature it belongs to, and numbers are entered in text fields instead of sliders.
- **Removed `commandToken` and `commandRefreshDelaySeconds`.** A second API key brings no extra requests, because the rate limit applies per vehicle, and the expected state after a command makes an extra refresh unnecessary. The plugin uses the API key for everything and warns once if the old options are still in the config.
- **The log lists what your vehicle supports** after the first update, including features that are supported but turned off, with the setting that turns them on.
- `airConditioningWithoutExternalPower` is a choice of "Keep the vehicle's setting", "Allow" (`"allow"`) and "Do not allow" (`"deny"`). Existing `true` / `false` values keep working.

## 0.2.0

- **Commands cost one request.** HomeKit keeps the expected state until a regular update carries the vehicle's new report of that part, at most 15 minutes, instead of an extra refresh after every command. With the default polling interval, that leaves 8 instead of about 4 commands per hour. `commandRefreshDelaySeconds` now defaults to `0` (no refresh); set it to 15–600 to keep the old behaviour. If you set it explicitly, nothing changes for you.
- **Controls follow the vehicle more carefully.** A control is removed only when two updates report its operation as unsupported, so a single odd response no longer costs you its room and automations in the Home app. A command the vehicle rejects as unsupported (`operation-not-supported`) removes its control as well. Disabled functions (`operation-disabled`) keep their control.
- **Fixed:** services added to or removed from a vehicle that was already in HomeKit were only saved to Homebridge's accessory cache on a clean shutdown. They are now saved right away.
- **Fixed:** a request the vehicle declined (`429 vehicle-not-accepting-requests`) was not counted against the request budget. The API counts it.
- **Fuel level** for petrol, diesel, CNG and LPG vehicles, as a battery "Fuel" that cannot be charged, with low battery below `lowBatteryThreshold`. It is on by default, so existing combustion vehicles get the new service after the update. An optional humidity sensor "Fuel Level" mirrors it for automations, also for plug-in hybrids (`features.fuelLevelSensor`).
- **Lights** as an optional contact sensor, open while the lights are on (`features.lights`).
- The log shows at startup how many requests per hour polling uses and how many are left for commands.

## 0.1.3

- The author link on npm points to [eikedreier.com](https://eikedreier.com/).

## 0.1.2

- **Fixed:** while pairing, the Home app could replace the sensor names with generic ones ("Contact Sensor 2"). A new vehicle was published to HomeKit before its sensors existed, so they were added during pairing. Now a new vehicle is published once the first update has created all its sensors. If your sensors already have generic names, remove the bridge from the Home app and pair it again.
- The README shows the install command for the Homebridge terminal: `hb-service add @thecloudseeker/homebridge-skoda`.

## 0.1.1

- **Fixed:** the Homebridge UI stored the sections of the vehicle form (commands, home location, polling, features) as separate vehicle entries without VIN and key. All fields of a vehicle now stay in one entry. If you saved the config with 0.1.0, remove the extra entries or add the vehicle again.

## 0.1.0

First release, for the official MyŠkoda Public API (contract 1.1.0).

- **One accessory per vehicle**, with a service for each feature the vehicle supports: battery, charging (outlet), charge limit (lightbulb brightness), air conditioning (heater cooler), auxiliary heating with S-PIN, active ventilation, "Home" occupancy sensor, and contact sensors for doors, windows, trunk, bonnet, sunroof and lock state. An optional humidity sensor mirrors the state of charge for automations.
- **Within the rate limit:** at most 20 requests per hour per vehicle, following the `RateLimit-*` headers, with four requests kept free for commands. HomeKit reads come from the cache and never reach the API.
- **Commands** update HomeKit right away and are confirmed by one refresh shortly after. The plugin backs off on `429`, `5xx` and network errors, and stale data shows as a fault on the sensors.
- **API keys:** an optional second key for commands, a warning seven days before a key expires, and a clear message for expired, invalid or deleted keys. Keys and the S-PIN never appear in the log, the VIN only as its last four characters.
- **Homebridge UI** settings with password fields for the keys and the S-PIN.
- The ventilation switch shows the state the API reports, like the MyŠkoda app. A ventilation started through the Public API runs but is not reported as running.
