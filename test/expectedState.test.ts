import { describe, expect, it } from "vitest";
import {
  EXPECTED_STATE_TTL_MS,
  ExpectedState,
  type OptimisticPatch,
} from "../src/vehicle/expectedState.js";
import {
  mergeSnapshot,
  type VehicleSnapshot,
} from "../src/vehicle/snapshot.js";
import { loadFixture } from "./helpers.js";

const SENT_AT = Date.parse("2026-10-31T09:00:00Z");

/** The Enyaq as polled at `fetchedAt`, with the charging part captured at `capturedAt`. */
function poll(fetchedAt: number, capturedAt = "2026-10-31T08:00:00Z") {
  const response = loadFixture("enyaq");
  response.vehicle.charging!.carCapturedTimestamp = capturedAt;
  return mergeSnapshot(undefined, response, fetchedAt);
}

const stopCharging: OptimisticPatch = {
  part: "charging",
  apply: (vehicle) => {
    vehicle.charging!.status!.state = "READY_FOR_CHARGING";
  },
};

const state = (snapshot: VehicleSnapshot | undefined) =>
  snapshot?.vehicle.charging?.status?.state;

describe("ExpectedState", () => {
  it("applies an accepted command to the current snapshot without changing it", () => {
    const expected = new ExpectedState();
    const current = poll(SENT_AT);
    expect(state(expected.add(stopCharging, current, SENT_AT))).toBe(
      "READY_FOR_CHARGING",
    );
    expect(state(current)).toBe("CHARGING");
    expect(expected.add(stopCharging, undefined, SENT_AT)).toBeUndefined();
  });

  it("keeps the expected state until the vehicle reports the part after the command", () => {
    const expected = new ExpectedState();
    expected.add(stopCharging, poll(SENT_AT), SENT_AT);

    expect(state(expected.apply(poll(SENT_AT + 60_000)))).toBe(
      "READY_FOR_CHARGING",
    );
    // Captured before the command: not an answer to it.
    expect(
      state(expected.apply(poll(SENT_AT + 120_000, "2026-10-31T08:59:00Z"))),
    ).toBe("READY_FOR_CHARGING");
    // Captured after the command: the vehicle's report wins, and the patch is gone.
    expect(
      state(expected.apply(poll(SENT_AT + 180_000, "2026-10-31T09:02:00Z"))),
    ).toBe("CHARGING");
    expect(state(expected.apply(poll(SENT_AT + 240_000)))).toBe("CHARGING");
  });

  it("drops the expected state after 15 minutes without a report", () => {
    const expected = new ExpectedState();
    expected.add(stopCharging, poll(SENT_AT), SENT_AT);
    expect(
      state(expected.apply(poll(SENT_AT + EXPECTED_STATE_TTL_MS - 1))),
    ).toBe("READY_FOR_CHARGING");
    expect(state(expected.apply(poll(SENT_AT + EXPECTED_STATE_TTL_MS)))).toBe(
      "CHARGING",
    );
  });

  it("hides rejected operations in every later snapshot", () => {
    const expected = new ExpectedState();
    const names = (snapshot: VehicleSnapshot) =>
      snapshot.vehicle.operations?.map((operation) => operation.name) ?? [];
    expect(names(expected.withoutRejected(poll(SENT_AT)))).toContain(
      "setChargingLimit",
    );

    expected.reject(["setChargingLimit"]);
    expect(names(expected.withoutRejected(poll(SENT_AT)))).not.toContain(
      "setChargingLimit",
    );
    expect(names(expected.apply(poll(SENT_AT)))).not.toContain(
      "setChargingLimit",
    );
  });
});
