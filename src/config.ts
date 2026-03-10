import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { UserError } from "./errors.ts";
import type { AppConfig, ReasoningMode } from "./types.ts";

type PartialConfig = Partial<AppConfig>;

const DEFAULT_MODEL = "qwen/qwen3-235b-a22b-2507";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_SYSTEM_PROMPT =
  "You write concise, high-signal git commit messages in Conventional Commit style when appropriate. Return only the commit message, with an optional body separated by a blank line. No code fences, no commentary.";

export function loadConfig(cwd: string, env: NodeJS.ProcessEnv): AppConfig {
  const fileConfig = loadConfigFile(cwd, env);

  return {
    apiKey: env.OPENROUTER_API_KEY ?? fileConfig.apiKey,
    model: env.AUTOGIT_MODEL ?? fileConfig.model ?? DEFAULT_MODEL,
    baseUrl: env.OPENROUTER_BASE_URL ?? fileConfig.baseUrl ?? DEFAULT_BASE_URL,
    systemPrompt:
      env.AUTOGIT_SYSTEM_PROMPT ?? fileConfig.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    defaultBaseBranch:
      env.AUTOGIT_DEFAULT_BASE_BRANCH ?? fileConfig.defaultBaseBranch,
    reasoningMode: parseReasoningMode(env.AUTOGIT_REASONING) ?? fileConfig.reasoningMode ?? "auto",
  };
}

function loadConfigFile(cwd: string, env: NodeJS.ProcessEnv): PartialConfig {
  const candidatePaths = [
    env.AUTOGIT_CONFIG,
    path.join(cwd, "autogit.config.json"),
    path.join(os.homedir(), ".config", "autogit", "config.json"),
  ].filter((value): value is string => Boolean(value));

  for (const candidatePath of candidatePaths) {
    let raw: string;
    try {
      raw = fs.readFileSync(candidatePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new UserError(`Invalid JSON in config file: ${candidatePath}`);
    }

    return normalizeConfig(parsed, candidatePath);
  }

  return {};
}

function normalizeConfig(value: unknown, sourcePath: string): PartialConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UserError(`Config file must contain a JSON object: ${sourcePath}`);
  }

  const config = value as Record<string, unknown>;
  const normalized: PartialConfig = {};

  copyString(config, normalized, "apiKey");
  copyString(config, normalized, "model");
  copyString(config, normalized, "baseUrl");
  copyString(config, normalized, "systemPrompt");
  copyString(config, normalized, "defaultBaseBranch");
  copyReasoningMode(config, normalized, "reasoningMode");
  copyLegacyReasoningEnabled(config, normalized);

  return normalized;
}

function copyString(
  source: Record<string, unknown>,
  target: PartialConfig,
  key: keyof AppConfig,
): void {
  const value = source[key];

  if (value === undefined) {
    return;
  }

  if (typeof value !== "string") {
    throw new UserError(`Config field "${key}" must be a string.`);
  }

  target[key] = value;
}

function copyReasoningMode(
  source: Record<string, unknown>,
  target: PartialConfig,
  key: "reasoningMode",
): void {
  const value = source[key];

  if (value === undefined) {
    return;
  }

  if (typeof value !== "string" || !isReasoningMode(value)) {
    throw new UserError(`Config field "${key}" must be one of: auto, on, off.`);
  }

  target[key] = value;
}

function copyLegacyReasoningEnabled(
  source: Record<string, unknown>,
  target: PartialConfig,
): void {
  if (target.reasoningMode !== undefined) {
    return;
  }

  const value = source.reasoningEnabled;

  if (value === undefined) {
    return;
  }

  if (typeof value !== "boolean") {
    throw new UserError('Config field "reasoningEnabled" must be a boolean.');
  }

  target.reasoningMode = value ? "on" : "off";
}

function parseReasoningMode(value: string | undefined): ReasoningMode | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "auto") {
    return "auto";
  }

  if (/^(1|true|yes|on|enabled)$/i.test(normalized)) {
    return "on";
  }

  if (/^(0|false|no|off|disabled|none)$/i.test(normalized)) {
    return "off";
  }

  throw new UserError(
    "AUTOGIT_REASONING must be one of: auto, on, off, true, false, 1, 0, yes, no.",
  );
}

function isReasoningMode(value: string): value is ReasoningMode {
  return value === "auto" || value === "on" || value === "off";
}

export function requireApiKey(config: AppConfig): AppConfig & { apiKey: string } {
  if (!config.apiKey) {
    throw new UserError(
      "Missing OPENROUTER_API_KEY. Set it in your environment or define apiKey in autogit.config.json.",
    );
  }

  return config as AppConfig & { apiKey: string };
}
