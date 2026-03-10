import { UserError } from "./errors.ts";
import type { ParsedCommand } from "./types.ts";

const COMMANDS = new Set(["commit", "push", "pr", "gitignore", "publish", "status", "help"]);

export function parseArgs(argv: string[]): ParsedCommand {
  const [maybeCommand, ...rest] = argv;

  if (!maybeCommand || maybeCommand === "--help" || maybeCommand === "-h") {
    return { name: "help", flags: {}, positionals: [] };
  }

  if (!COMMANDS.has(maybeCommand)) {
    throw new UserError(`Unknown command: ${maybeCommand}`);
  }

  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    if (
      token === "--yes" ||
      token === "--all" ||
      token === "--reasoning" ||
      token === "--no-reasoning" ||
      token === "--public" ||
      token === "--private"
    ) {
      flags[token.slice(2)] = true;
      continue;
    }

    if (token === "--model" || token === "--base" || token === "--title" || token === "--body") {
      const value = rest[index + 1];
      if (!value || value.startsWith("-")) {
        throw new UserError(`Flag ${token} requires a value.`);
      }

      flags[token.slice(2)] = value;
      index += 1;
      continue;
    }

    throw new UserError(`Unknown flag: ${token}`);
  }

  return {
    name: maybeCommand as ParsedCommand["name"],
    flags,
    positionals,
  };
}

export function helpText(): string {
  return `autogit

Usage:
  autogit commit [--model <id>] [--yes] [--all] [--reasoning] [--no-reasoning]
  autogit push
  autogit pr [--base <branch>] [--title <title>] [--body <body>]
  autogit gitignore [--yes]
  autogit publish [<name>] [--public|--private] [--yes]
  autogit status

The commit command is the main interactive flow. After generating an
AI commit message, you can commit, push, switch branch, edit, or
regenerate. If you push from a feature branch, you will be offered
to create a pull request.

Config:
  OPENROUTER_API_KEY            Required unless apiKey is set in config
  AUTOGIT_MODEL                 Overrides the default OpenRouter model
  OPENROUTER_BASE_URL           Overrides the OpenRouter API base URL
  AUTOGIT_SYSTEM_PROMPT         Overrides the commit generation prompt
  AUTOGIT_DEFAULT_BASE_BRANCH   Default PR base branch
  AUTOGIT_REASONING             Reasoning mode: auto, on, or off
  AUTOGIT_CONFIG                Path to a JSON config file

Config file locations:
  ./autogit.config.json
  ~/.config/autogit/config.json`;
}
