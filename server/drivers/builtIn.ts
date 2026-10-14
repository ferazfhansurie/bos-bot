// Built-in driver registration — upstream builtInDrivers.ts: a static
// array, nothing more. Adding a driver = write drivers/<x>.ts, append.
import type { AnyProviderDriver } from "../contracts.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { ApiKeyDriver } from "./api-key.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { CursorAgentDriver } from "./acp/cursor.ts";
import { DroidAgentDriver } from "./acp/droid.ts";
import { GeminiAgentDriver } from "./acp/gemini.ts";
import { GrokAgentDriver } from "./acp/grok.ts";
import { HermesAgentDriver } from "./acp/hermes.ts";
import { KimiAgentDriver } from "./acp/kimi.ts";
import { OpenCodeDriver } from "./acp/opencode-go.ts";
import { OpenRouterFreeDriver } from "./openrouter-free.ts";
import { PiDriver } from "./pi.ts";
import { QwenAgentDriver } from "./acp/qwen.ts";

// The agent CLI engines came back for Settings → Engines → Add an engine.
// The API-key Grok, OpenAI-compatible, MiniMax and Computer drivers stay out:
// "Any other model by API key" covers those providers on the api-key driver.
export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [
  ClaudeDriver,
  CodexDriver,
  OpenCodeDriver,
  PiDriver,
  AntigravityDriver,
  GeminiAgentDriver,
  CursorAgentDriver,
  DroidAgentDriver,
  GrokAgentDriver,
  KimiAgentDriver,
  QwenAgentDriver,
  HermesAgentDriver,
  OpenRouterFreeDriver,
  ApiKeyDriver,
];
