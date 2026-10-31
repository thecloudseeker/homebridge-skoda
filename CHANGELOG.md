# Changelog

## 0.1.0

First release, for the official MyŠkoda Public API (contract 1.1.0).

- **One accessory per vehicle**, with a service for each feature the vehicle supports: battery, charging (outlet), charge limit (lightbulb brightness), air conditioning (heater cooler), auxiliary heating with S-PIN, active ventilation, "Home" occupancy sensor, and contact sensors for doors, windows, trunk, bonnet, sunroof and lock state. An optional humidity sensor mirrors the state of charge for automations.
- **Within the rate limit:** at most 20 requests per hour per vehicle, following the `RateLimit-*` headers, with four requests kept free for commands. HomeKit reads come from the cache and never reach the API.
- **Commands** update HomeKit right away and are confirmed by one refresh shortly after. The plugin backs off on `429`, `5xx` and network errors, and stale data shows as a fault on the sensors.
- **API keys:** an optional second key for commands, a warning seven days before a key expires, and a clear message for expired, invalid or deleted keys. Keys and the S-PIN never appear in the log, the VIN only as its last four characters.
- **Homebridge UI** settings with password fields for the keys and the S-PIN.
- The ventilation switch shows the state the API reports, like the MyŠkoda app. A ventilation started through the Public API runs but is not reported as running.
