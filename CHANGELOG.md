# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

### Added

- Dynamic platform for the official MyŠkoda Public API (contract 1.1.0), one accessory per vehicle.
- Battery service, optional humidity sensor that mirrors the state of charge.
- Outlet to start and stop charging; *Outlet In Use* shows whether the cable is plugged in.
- Lightbulb that sets the charging limit through its brightness.
- Heater cooler for the air conditioning with target temperature.
- Switches for the auxiliary heating (with S-PIN) and the active ventilation.
- Occupancy sensor "Home" based on the parking position and a configurable radius.
- Contact sensors for doors, windows, trunk, bonnet, sunroof and lock state.
- Services are created only for features the vehicle supports.
- Request budget that keeps within 20 requests per hour per vehicle, follows the `RateLimit-*`
  headers and keeps four requests free for commands.
- One follow-up refresh after commands, optimistic HomeKit updates, backoff on `429`, `5xx` and
  network errors, *StatusFault* for stale data, warning before API keys expire.
- Optional separate API key for commands.
- The ventilation switch shows the reported state like the MyŠkoda app, because vehicles do not
  report a running ventilation.
- Clear log message for invalid or deleted API keys.
- Homebridge UI settings with password fields for keys and S-PIN.

[0.1.0]: https://github.com/thecloudseeker/homebridge-skoda/releases/tag/v0.1.0
