import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

// Runs the suite against Homebridge 1.x, whose HAP-NodeJS is published as `hap-nodejs`.
export default mergeConfig(
  base,
  defineConfig({
    resolve: { alias: { "@homebridge/hap-nodejs": "hap-nodejs" } },
  }),
);
