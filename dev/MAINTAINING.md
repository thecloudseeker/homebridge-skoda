# Maintaining

## Upstream check (monthly)

The plugin follows the MyŠkoda Public API contract directly. Two open-source projects use the same
API and often find out first when it changes. Check all three once a month. The
[Upstream check](../.github/workflows/upstream-check.yml) workflow opens an issue with this checklist
and the current upstream versions on the 1st of every month, and you can also run it by hand from
the Actions tab.

| Source                         | Where                                                                                                                                                                                    | What to look for                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| MyŠkoda Public API             | [Changelog](https://public.api.connect.skoda-auto.cz/docs/changelog), [OpenAPI](https://public.api.connect.skoda-auto.cz/v3/api-docs)                                                    | New contract version, new fields or enum values, new operations, new error or problem types, rate limit changes   |
| skoda-public-api (Python, MIT) | [Releases](https://github.com/mobility-lab-vsb/skoda-public-api/releases), [pull requests](https://github.com/mobility-lab-vsb/skoda-public-api/pulls)                                   | Fixes that point to API behaviour we do not handle yet (fields, enum values, error mapping)                       |
| Home Assistant `skoda`         | [Integration source](https://github.com/home-assistant/core/tree/dev/homeassistant/components/skoda), [open PRs](https://github.com/home-assistant/core/pulls?q=is%3Apr+is%3Aopen+skoda) | New controls, how they detect support, optimistic state and rate limit handling, the library version they require |

When something is relevant:

- Update [src/api/types.ts](../src/api/types.ts) from the OpenAPI document, and the contract version
  in its header comment.
- Compare the OpenAPI document with the snapshot in [dev/api/openapi.json](api/openapi.json);
  the workflow does this and says in the issue whether it changed. To compare by hand:
  `curl -s https://public.api.connect.skoda-auto.cz/v3/api-docs | python3 -m json.tool --indent 2 | diff dev/api/openapi.json -`.
  After going through a change, save the new document with the same command and `> dev/api/openapi.json`.
- Reimplement from the API documentation rather than copying code. If code is ever copied, keep
  the MIT notice (skoda-public-api) or the Apache 2.0 notices (Home Assistant) with it.
- Note what was checked in the issue, then close it.

### Last check

2026-11-03:

- API contract 1.1.0, unchanged. The OpenAPI document has a write-only, self-referencing property
  `tings` on `Charging` and `ChargingProfile`; it looks like a generator artifact and never appears
  in responses. Snapshot saved in dev/api/openapi.json.
- skoda-public-api v1.4.0 released (operations list, plug state, charge limit). Open: #31 (heater
  used as heat source for climatisation cannot be started through the public API), #36, #37.
- Home Assistant requires `skoda-public-api==1.4.0` and has charging and active ventilation
  switches (#190013). Open: #190215 (charging cable, air conditioning and auxiliary heating binary
  sensors), #189826 (reauthentication), #189866 (vehicle image).
