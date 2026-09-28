import { readFileSync } from "node:fs";
export const STAGING = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).bosChannel === "staging";
export const SERVER_PORTS = STAGING ? [38799, 48799, 58799] : [8799, 18799, 28799];
export const RELAY_PORTS = STAGING ? [38798, 48798, 58798] : [8798, 18798, 28798];
export const COMPANION_PORT = STAGING ? 38810 : 8810;
export const CONTROL_PORT = STAGING ? 38811 : 8811;
export const PACKAGE_SCHEME = STAGING ? "bosbot-staging" : "openmausbot";
