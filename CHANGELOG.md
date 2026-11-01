# Changelog

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
