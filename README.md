# autogit

`autogit` is a small CLI for AI-assisted git workflows using OpenRouter.

## Commands

```bash
autogit commit [--model <id>] [--yes] [--all] [--reasoning] [--no-reasoning]
autogit push
autogit pr [--base <branch>] [--title <title>] [--body <body>]
autogit branch-commit <branch> [--model <id>] [--yes] [--all] [--reasoning] [--no-reasoning]
autogit gitignore [--yes]
autogit publish [<name>] [--public|--private] [--yes]
```

`autogit commit` now prompts to stage all changes when the working tree is dirty but nothing is staged. Use `--all` to skip that prompt and stage everything immediately.
Reasoning uses `auto` mode by default, which lets OpenRouter/model defaults decide. Use `--reasoning` to force it on or `--no-reasoning` to request it off. If a provider rejects `off`, autogit retries once in `auto` mode.
Commit generation uses token streaming when OpenRouter returns SSE, so you can see the commit message arrive in real time before confirmation.
`autogit gitignore` inspects the project and creates or appends common `.gitignore` rules for detected stacks like Node.js, Python, and Rust.
`autogit publish` creates a GitHub repository with `gh repo create`, sets `origin`, and pushes the current branch. It defaults to `private` unless you pass `--public`.
The terminal UI includes a lightweight spinner while the model is thinking, then switches cleanly into streamed output when tokens arrive.
Interactive commits now offer actions after generation: commit, commit and push, edit, regenerate, or cancel.

## Configuration

Required:

- `OPENROUTER_API_KEY`

Optional environment variables:

- `AUTOGIT_MODEL`
- `OPENROUTER_BASE_URL`
- `AUTOGIT_SYSTEM_PROMPT`
- `AUTOGIT_DEFAULT_BASE_BRANCH`
- `AUTOGIT_REASONING`
- `AUTOGIT_CONFIG`

Optional config file locations:

- `./autogit.config.json`
- `~/.config/autogit/config.json`

Example config:

```json
{
  "model": "qwen/qwen3-235b-a22b-2507",
  "defaultBaseBranch": "main",
  "reasoningMode": "auto"
}
```

## Local usage

```bash
npm test
node ./bin/autogit.js commit
```
