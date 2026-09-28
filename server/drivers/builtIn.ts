// Built-in driver registration — upstream builtInDrivers.ts: a static
// array, nothing more. Adding a driver = write drivers/<x>.ts, append.
import type { AnyProviderDriver } from "../contracts.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { OpenRouterFreeDriver } from "./openrouter-free.ts";

export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [
  ClaudeDriver,
  CodexDriver,
  OpenRouterFreeDriver,
];
