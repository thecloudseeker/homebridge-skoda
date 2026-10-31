import { readFileSync } from "node:fs";
import { vi } from "vitest";
import type { VehicleResponse } from "../src/api/types.js";

/** Fake VIN from the official API documentation. */
export const TEST_VIN = "TMBJB9NY5RF999999";
/** Obviously fake keys, never real ones. */
export const TEST_TOKEN = "test-poll-key-not-real";
export const TEST_COMMAND_TOKEN = "test-command-key-not-real";

export function loadFixture(name: string): VehicleResponse {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  ) as VehicleResponse;
}

export interface MockResponseInit {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export function mockResponse({
  status = 200,
  body,
  headers = {},
}: MockResponseInit = {}): Response {
  const isProblem = status >= 400;
  const text = body === undefined ? null : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: {
      "Content-Type": isProblem
        ? "application/problem+json"
        : "application/json",
      ...headers,
    },
  });
}

export function problem(
  status: number,
  type?: string,
  detail?: string,
): unknown {
  return {
    type: type
      ? `https://public.api.connect.skoda-auto.cz/problems/${type}`
      : "about:blank",
    title: "Problem",
    status,
    detail,
  };
}

/** A fetch mock that answers with the queued responses in order. */
export function mockFetch(...responses: (Response | Error)[]) {
  const queue = [...responses];
  return vi.fn<typeof fetch>(() => {
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error("no mocked response left"));
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
}

export function silentLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}
