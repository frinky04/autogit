# autogit

A CLI for AI-assisted git commits using [OpenRouter](https://openrouter.ai).

## Commands

```bash
autogit commit [--model <id>] [--yes] [--all] [--reasoning] [--no-reasoning]
autogit push
autogit pr [--base <branch>] [--model <id>] [--yes] [--reasoning] [--no-reasoning]
autogit gitignore [--yes]
autogit publish [<name>] [--public|--private] [--yes]
autogit status
```

### `commit`

The main command. Generates an AI commit message from your staged diff and walks you through the rest interactively:

1. If nothing is staged, offers to stage all changes.
2. If staged and unstaged/untracked changes are mixed, offers to stage everything first (or use `--all` to skip this prompt).
3. Sends the diff to OpenRouter and streams the suggested commit message in real time.
4. Presents an action menu:
   - **Enter** — commit
   - **p** — commit and push
   - **b** — switch to a new branch, then commit
   - **e** — edit the message
   - **r** — regenerate (with optional feedback like "shorter" or "more conventional")
   - **c** — cancel
5. If you push from a feature branch, offers to create a pull request via `gh`.

Use `--yes` to skip all prompts and commit immediately. Use `--model` to override the configured model for a single run.

### `push`

Pushes the current branch, setting upstream automatically if needed.

### `pr`

Generates a pull request draft with OpenRouter, then creates it via `gh pr create`:

1. Verifies branch/base setup (uses `--base`, config default base, or detected remote default branch).
2. Warns if uncommitted changes exist (they are not included in PR generation).
3. Pushes the current branch.
4. Diffs `base...HEAD` and asks OpenRouter once for PR title + description.
5. Lets you create immediately or cancel.

Use `--yes` to skip prompts and create the PR from the first draft.

### `gitignore`

Detects your project stack (Node.js, Python, Rust) and appends common `.gitignore` rules. Use `--yes` to skip confirmation.

### `publish`

Creates a GitHub repository with `gh repo create`, sets `origin`, and pushes. Defaults to private; pass `--public` to override.

### `status`

Shows branch, upstream, and working-tree counts. Does not require OpenRouter configuration.

## Reasoning

Reasoning mode defaults to `auto`, letting the model/provider decide. Use `--reasoning` to force it on, `--no-reasoning` to request it off. If a provider rejects `off`, autogit retries once with `auto`.

## Configuration

Set `OPENROUTER_API_KEY` in your environment, or add `apiKey` to a config file.

Optional environment variables:

| Variable | Purpose |
|---|---|
| `AUTOGIT_MODEL` | Override the default model |
| `OPENROUTER_BASE_URL` | Override the OpenRouter API base URL |
| `AUTOGIT_SYSTEM_PROMPT` | Override the commit generation prompt |
| `AUTOGIT_DEFAULT_BASE_BRANCH` | Default PR base branch |
| `AUTOGIT_REASONING` | Reasoning mode: `auto`, `on`, or `off` |
| `AUTOGIT_CONFIG` | Path to a JSON config file |

Config file locations (checked in order):

1. `./autogit.config.json`
2. `~/.config/autogit/config.json`

Example config:

```json
{
  "model": "qwen/qwen3-235b-a22b-2507",
  "defaultBaseBranch": "main",
  "reasoningMode": "auto"
}
```

## Local development

```bash
npm test
node ./bin/autogit.js commit
```
