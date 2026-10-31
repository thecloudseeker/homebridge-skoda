import { readFileSync } from "node:fs";

export const PLATFORM_NAME = "Skoda";
export const PLUGIN_NAME = "@thecloudseeker/homebridge-skoda";

export const PLUGIN_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
