import { describe, expect, it } from "vitest";
import { haversineDistanceMeters, isWithinRadius } from "../src/util/geo.js";

const MLADA_BOLESLAV = { latitude: 50.4128, longitude: 14.9069 };
const PRAGUE = { latitude: 50.0755, longitude: 14.4378 };
const NASHVILLE = { latitude: 36.12, longitude: -86.67 };
const LOS_ANGELES = { latitude: 33.94, longitude: -118.4 };

describe("haversineDistanceMeters", () => {
  it("is zero for the same point", () => {
    expect(haversineDistanceMeters(PRAGUE, PRAGUE)).toBe(0);
  });

  it("matches the textbook example BNA – LAX", () => {
    // Rosetta Code reference: 2887.26 km with R = 6372.8 km, scaled to the mean Earth radius.
    const expectedKm = (2887.26 * 6371.0088) / 6372.8;
    expect(haversineDistanceMeters(NASHVILLE, LOS_ANGELES) / 1000).toBeCloseTo(
      expectedKm,
      0,
    );
  });

  it("measures one degree of latitude as ~111.2 km", () => {
    expect(
      haversineDistanceMeters(
        { latitude: 0, longitude: 0 },
        { latitude: 1, longitude: 0 },
      ),
    ).toBeCloseTo(111_195, -1);
  });

  it("is symmetric and handles the antimeridian", () => {
    const a = { latitude: 0, longitude: 179.9999 };
    const b = { latitude: 0, longitude: -179.9999 };
    expect(haversineDistanceMeters(a, b)).toBeCloseTo(22.2, 0);
    expect(haversineDistanceMeters(b, a)).toBeCloseTo(
      haversineDistanceMeters(a, b),
      6,
    );
  });
});

describe("isWithinRadius", () => {
  it("includes points on and inside the radius", () => {
    const near = {
      latitude: MLADA_BOLESLAV.latitude + 0.001,
      longitude: MLADA_BOLESLAV.longitude,
    };
    // 0.001° latitude ≈ 111 m
    expect(isWithinRadius(near, MLADA_BOLESLAV, 150)).toBe(true);
    expect(isWithinRadius(near, MLADA_BOLESLAV, 100)).toBe(false);
  });
});
