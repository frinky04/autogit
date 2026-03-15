import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { UserError } from "../src/errors.ts";
import { runCli } from "../src/cli.ts";
import { createNoopOutput } from "../src/output.ts";
import type { GitClient, OutputWriter } from "../src/types.ts";

function makeOutput(overrides: Partial<OutputWriter> = {}): OutputWriter {
  return { ...createNoopOutput(), ...overrides };
}

function makeMessageOutput(): { messages: string[]; output: OutputWriter } {
  const messages: string[] = [];
  return {
    messages,
    output: makeOutput({
      info(message: string) { messages.push(message); },
      error(message: string) { messages.push(message); },
      headline(message: string) { messages.push(message); },
      keyValue(label: string, value: string) { messages.push(`${label}: ${value}`); },
      box(title: string, content: string) { messages.push(title); messages.push(content); },
      success(message: string) { messages.push(message); },
      warn(message: string) { messages.push(message); },
    }),
  };
}

function makeGitClient(overrides: Partial<GitClient> = {}): GitClient {
  return {
    ensureGitAvailable() {},
    resolveRepoRoot() { return "/repo"; },
    getCurrentBranch() { return "main"; },
    getStagedFiles() { return ["file.txt"]; },
    getStatusSummary() { return makeStatusSummary(); },
    getStagedDiff() { return "diff --git a/file.txt b/file.txt"; },
    hasWorkingTreeChanges() { return true; },
    getDefaultBaseBranch() { return "main"; },
    getBranchDiff() { return "diff --git a/file.txt b/file.txt"; },
    getCommitLog() { return "abc123 feat: update file"; },
    stageAllChanges() {},
    commitWithMessage() {},
    switchToNewBranch() {},
    pushCurrentBranch() { return "main"; },
    createPullRequest() {},
    publishRepository() { return "repo"; },
    ...overrides,
  };
}

function makeStatusSummary(overrides: Partial<{
  branchName: string;
  upstream?: string;
  ahead: number;
  behind: number;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  clean: boolean;
}> = {}) {
  return {
    branchName: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    stagedCount: 1,
    unstagedCount: 0,
    untrackedCount: 0,
    clean: false,
    ...overrides,
  };
}

test("runCli commit creates a commit from staged changes", async () => {
  const commits: string[] = [];
  const streamed: string[] = [];
  let streamEnded = 0;
  let spinnerStarted = 0;
  let spinnerStopped = 0;

  const { messages, output } = makeMessageOutput();
  output.stream = (chunk: string) => { streamed.push(chunk); };
  output.endStream = () => { streamEnded += 1; };
  output.startSpinner = () => { spinnerStarted += 1; };
  output.stopSpinner = () => { spinnerStopped += 1; };

  const exitCode = await runCli(["commit", "--yes"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key",
    },
    output,
    prompt: {
      async confirm() {
        return true;
      },
      async chooseCommitAction() {
        return "commit";
      },
      async editMessage(message) {
        return message;
      },
    },
    gitClient: makeGitClient({
      commitWithMessage(_, message) { commits.push(message); },
    }),
    async generateCommitMessage(_, __, ___, options) {
      options?.onToken?.("feat: ");
      options?.onToken?.("add hello file");
      options?.onUsage?.({
        promptTokens: 120,
        completionTokens: 8,
        totalTokens: 128,
        costCredits: 0.00012999,
      });
      return "feat: add hello file";
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(commits, ["feat: add hello file"]);
  assert.deepEqual(streamed, ["feat: ", "add hello file"]);
  assert.equal(streamEnded, 1);
  assert.equal(spinnerStarted, 1);
  assert.equal(spinnerStopped, 2);
  assert.ok(messages.some((message) => message.includes("AutoGit")));
  assert.ok(messages.some((message) => message.includes("main")));
  assert.ok(messages.some((message) => message.includes("Suggested commit message")));
  assert.ok(messages.some((message) => message.includes("Token usage")));
  assert.ok(messages.some((message) => message.includes("Total: 128")));
  assert.ok(messages.some((message) => message.includes("Estimated cost: $0.00012999")));
  assert.ok(messages.some((message) => message.includes("Committed changes.")));
});

test("runCli retries with auto reasoning when provider rejects no-reasoning", async () => {
  const commits: string[] = [];
  const reasoningModes: string[] = [];
  const { messages, output } = makeMessageOutput();

  const exitCode = await runCli(["commit", "--no-reasoning", "--yes"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key",
    },
    output,
    prompt: {
      async confirm() {
        return true;
      },
      async chooseCommitAction() {
        return "commit";
      },
      async editMessage(message) {
        return message;
      },
    },
    gitClient: makeGitClient({
      commitWithMessage(_, message) { commits.push(message); },
    }),
    async generateCommitMessage(_, request) {
      reasoningModes.push(request.reasoningMode);

      if (request.reasoningMode === "off") {
        throw new UserError(
          'OpenRouter request failed (400): {"error":{"message":"Reasoning is mandatory for this endpoint and cannot be disabled.","code":400}}',
        );
      }

      return "feat: fallback to auto reasoning";
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(reasoningModes, ["off", "auto"]);
  assert.deepEqual(commits, ["feat: fallback to auto reasoning"]);
  assert.ok(
    messages.some((message) =>
      message.includes("Reasoning cannot be disabled for this model/provider."),
    ),
  );
});

test("runCli commit prompts to stage all when nothing is staged", async () => {
  const commits: string[] = [];
  let staged = false;
  const actionCalls: string[] = [];
  const { messages, output } = makeMessageOutput();

  const exitCode = await runCli(["commit"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key",
    },
    output,
    prompt: {
      async confirm(message: string) {
        if (message.includes("Stage all")) {
          return true;
        }

        return true;
      },
      async chooseCommitAction() {
        actionCalls.push("commit");
        return "commit";
      },
      async editMessage(message) {
        return message;
      },
    },
    gitClient: makeGitClient({
      getStagedDiff() { return staged ? "diff --git a/file.txt b/file.txt" : ""; },
      stageAllChanges() { staged = true; },
      commitWithMessage(_, message) { commits.push(message); },
    }),
    async generateCommitMessage() {
      return "feat: stage and commit changes";
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(commits, ["feat: stage and commit changes"]);
  assert.deepEqual(actionCalls, ["commit"]);
  assert.ok(messages.some((message) => message.includes("Staging all changes.")));
});

test("runCli commit --all stages without prompting first", async () => {
  const commits: string[] = [];
  let staged = false;
  let confirmCalls = 0;

  const exitCode = await runCli(["commit", "--all", "--yes"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key",
    },
    output: makeOutput(),
    prompt: {
      async confirm() {
        confirmCalls += 1;
        return true;
      },
    },
    gitClient: makeGitClient({
      getStagedDiff() { return staged ? "diff --git a/file.txt b/file.txt" : ""; },
      stageAllChanges() { staged = true; },
      commitWithMessage(_, message) { commits.push(message); },
    }),
    async generateCommitMessage() {
      return "feat: add staged changes";
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(commits, ["feat: add staged changes"]);
  assert.equal(confirmCalls, 0);
});

test("runCli commit prompts to stage all when unstaged changes exist", async () => {
  const commits: string[] = [];
  const prompts: string[] = [];
  let includesUnstaged = false;

  const exitCode = await runCli(["commit"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key",
    },
    output: makeOutput(),
    prompt: {
      async confirm(message: string) {
        prompts.push(message);
        return true;
      },
      async chooseCommitAction() {
        return "commit";
      },
      async editMessage(message) {
        return message;
      },
    },
    gitClient: makeGitClient({
      getStatusSummary() {
        return makeStatusSummary({
          stagedCount: 1,
          unstagedCount: 1,
          untrackedCount: 1,
          clean: false,
        });
      },
      getStagedDiff() {
        return includesUnstaged
          ? "diff --git a/all.txt b/all.txt"
          : "diff --git a/staged.txt b/staged.txt";
      },
      stageAllChanges() {
        includesUnstaged = true;
      },
      commitWithMessage(_, message) { commits.push(message); },
    }),
    async generateCommitMessage(_, request) {
      assert.equal(request.diff, "diff --git a/all.txt b/all.txt");
      return "feat: include unstaged changes";
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(commits, ["feat: include unstaged changes"]);
  assert.ok(
    prompts.some((message) =>
      message.includes("Unstaged or untracked changes found. Stage all tracked and untracked changes?"),
    ),
  );
});

test("runCli commit --all stages unstaged changes when staged changes already exist", async () => {
  const commits: string[] = [];
  let confirmCalls = 0;
  let stageAllCalls = 0;
  let includesUnstaged = false;

  const exitCode = await runCli(["commit", "--all", "--yes"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key",
    },
    output: makeOutput(),
    prompt: {
      async confirm() {
        confirmCalls += 1;
        return true;
      },
    },
    gitClient: makeGitClient({
      getStatusSummary() {
        return makeStatusSummary({
          stagedCount: 1,
          unstagedCount: 2,
          untrackedCount: 1,
          clean: false,
        });
      },
      getStagedDiff() {
        return includesUnstaged
          ? "diff --git a/all.txt b/all.txt"
          : "diff --git a/staged.txt b/staged.txt";
      },
      stageAllChanges() {
        stageAllCalls += 1;
        includesUnstaged = true;
      },
      commitWithMessage(_, message) { commits.push(message); },
    }),
    async generateCommitMessage(_, request) {
      assert.equal(request.diff, "diff --git a/all.txt b/all.txt");
      return "feat: stage all changes";
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(confirmCalls, 0);
  assert.equal(stageAllCalls, 1);
  assert.deepEqual(commits, ["feat: stage all changes"]);
});

test("runCli commit --yes skips unstaged staging prompt when staged changes exist", async () => {
  const commits: string[] = [];
  let confirmCalls = 0;
  const stagedDiff = "diff --git a/staged.txt b/staged.txt";

  const exitCode = await runCli(["commit", "--yes"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key",
    },
    output: makeOutput(),
    prompt: {
      async confirm() {
        confirmCalls += 1;
        return true;
      },
    },
    gitClient: makeGitClient({
      getStatusSummary() {
        return makeStatusSummary({
          stagedCount: 1,
          unstagedCount: 2,
          untrackedCount: 1,
          clean: false,
        });
      },
      getStagedDiff() {
        return stagedDiff;
      },
      stageAllChanges() {
        throw new Error("stageAllChanges should not be called when --yes is used without --all");
      },
      commitWithMessage(_, message) { commits.push(message); },
    }),
    async generateCommitMessage(_, request) {
      assert.equal(request.diff, stagedDiff);
      return "feat: commit staged only";
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(confirmCalls, 0);
  assert.deepEqual(commits, ["feat: commit staged only"]);
});

test("runCli commit can commit and push from the action prompt", async () => {
  const commits: string[] = [];
  const pushes: string[] = [];
  const { messages, output } = makeMessageOutput();

  const exitCode = await runCli(["commit"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key",
    },
    output,
    prompt: {
      async confirm() {
        return true;
      },
      async chooseCommitAction() {
        return "push";
      },
      async editMessage(message) {
        return message;
      },
    },
    gitClient: makeGitClient({
      commitWithMessage(_, message) { commits.push(message); },
      pushCurrentBranch() { pushes.push("main"); return "main"; },
    }),
    async generateCommitMessage() {
      return "feat: commit and push";
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(commits, ["feat: commit and push"]);
  assert.deepEqual(pushes, ["main"]);
  assert.ok(messages.some((message) => message.includes("Committed and pushed branch: main")));
});

test("runCli commit can regenerate and edit before committing", async () => {
  const commits: string[] = [];
  const generated: string[] = [];
  const actions: Array<"regenerate" | "edit" | "commit"> = ["regenerate", "edit", "commit"];
  const feedback: string[] = [];

  const exitCode = await runCli(["commit"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key",
    },
    output: makeOutput(),
    prompt: {
      async confirm() {
        return true;
      },
      async chooseCommitAction() {
        return actions.shift() ?? "commit";
      },
      async editMessage() {
        return "feat: edited message";
      },
      async input() {
        return "make it shorter";
      },
    },
    gitClient: makeGitClient({
      commitWithMessage(_, message) { commits.push(message); },
    }),
    async generateCommitMessage(_, request) {
      feedback.push(request.regenerateFeedback ?? "");
      const value = generated.length === 0 ? "feat: first draft" : "feat: second draft";
      generated.push(value);
      return value;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(generated, ["feat: first draft", "feat: second draft"]);
  assert.deepEqual(feedback, ["", "make it shorter"]);
  assert.deepEqual(commits, ["feat: edited message"]);
});

test("runCli status renders repository status without config", async () => {
  const { messages, output } = makeMessageOutput();

  const exitCode = await runCli(["status"], {
    cwd: "/repo",
    output,
    gitClient: makeGitClient({
      getStatusSummary() {
        return makeStatusSummary({
          stagedCount: 2, unstagedCount: 1, untrackedCount: 3, ahead: 1, clean: false,
        });
      },
    }),
  });

  assert.equal(exitCode, 0);
  assert.ok(messages.some((message) => message.includes("AutoGit Status")));
  assert.ok(messages.some((message) => message.includes("Staged:    2")));
  assert.ok(messages.some((message) => message.includes("Pending changes detected.")));
});

test("runCli commit offers PR after push on a feature branch", async () => {
  const commits: string[] = [];
  const pushes: string[] = [];
  const prs: Array<{ base?: string }> = [];
  const prPromptDefaults: boolean[] = [];
  const { messages, output } = makeMessageOutput();

  const exitCode = await runCli(["commit"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key",
    },
    output,
    prompt: {
      async confirm(message: string, options?: { defaultValue?: boolean }) {
        if (message.includes("Create a pull request?")) {
          prPromptDefaults.push(options?.defaultValue ?? true);
          return true;
        }
        return true;
      },
      async chooseCommitAction() {
        return "push";
      },
      async editMessage(message) {
        return message;
      },
    },
    gitClient: makeGitClient({
      getCurrentBranch() { return "feature/my-feature"; },
      commitWithMessage(_, message) { commits.push(message); },
      pushCurrentBranch() { pushes.push("feature/my-feature"); return "feature/my-feature"; },
      createPullRequest(_, options) { prs.push(options); },
    }),
    async generateCommitMessage() {
      return "feat: new feature";
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(commits, ["feat: new feature"]);
  assert.deepEqual(pushes, ["feature/my-feature"]);
  assert.deepEqual(prs, [{ base: undefined }]);
  assert.deepEqual(prPromptDefaults, [false]);
  assert.ok(messages.some((message) => message.includes("Pull request created via gh.")));
});

test("runCli commit skips PR prompt when pushing on main", async () => {
  const prompts: string[] = [];
  const prs: Array<{ base?: string }> = [];

  const exitCode = await runCli(["commit"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key",
    },
    output: makeOutput(),
    prompt: {
      async confirm(message: string) {
        prompts.push(message);
        return true;
      },
      async chooseCommitAction() {
        return "push";
      },
      async editMessage(message) {
        return message;
      },
    },
    gitClient: makeGitClient({
      getCurrentBranch() { return "main"; },
      createPullRequest(_, options) { prs.push(options); },
    }),
    async generateCommitMessage() {
      return "feat: main branch push";
    },
  });

  assert.equal(exitCode, 0);
  assert.ok(!prompts.some((message) => message.includes("pull request")));
  assert.deepEqual(prs, []);
});

test("runCli commit can commit on a new branch from the action prompt", async () => {
  const commits: string[] = [];
  const switchedBranches: string[] = [];

  const exitCode = await runCli(["commit"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key",
    },
    output: makeOutput(),
    prompt: {
      async confirm() {
        return true;
      },
      async chooseCommitAction() {
        return "branch";
      },
      async editMessage(message) {
        return message;
      },
      async input(message: string) {
        if (message.includes("New branch name")) {
          return "feature/new-branch";
        }

        return "";
      },
    },
    gitClient: makeGitClient({
      commitWithMessage(_, message) { commits.push(message); },
      switchToNewBranch(_, branchName) { switchedBranches.push(branchName); },
      pushCurrentBranch() { return "feature/new-branch"; },
    }),
    async generateCommitMessage() {
      return "feat: branch commit";
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(switchedBranches, ["feature/new-branch"]);
  assert.deepEqual(commits, ["feat: branch commit"]);
});

test("runCli push sets upstream when missing", async () => {
  const { messages, output } = makeMessageOutput();

  const exitCode = await runCli(["push"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "unused-for-push",
    },
    output,
    gitClient: makeGitClient({
      getStatusSummary() { return makeStatusSummary({ stagedCount: 0, clean: true }); },
      hasWorkingTreeChanges() { return false; },
      pushCurrentBranch() { return "feature/pushed"; },
    }),
  });

  assert.equal(exitCode, 0);
  assert.ok(messages.some((message) => message.includes("Pushed branch")));
});

test("runCli pr generates a draft, pushes, and creates the PR", async () => {
  const pushes: string[] = [];
  const prs: Array<{ base?: string; title?: string; body?: string }> = [];
  const requests: string[] = [];
  const { messages, output } = makeMessageOutput();

  const exitCode = await runCli(["pr"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key",
    },
    output,
    prompt: {
      async confirm() {
        return true;
      },
      async choosePrAction() {
        return "create";
      },
    },
    gitClient: makeGitClient({
      getCurrentBranch() { return "feature/new-pr-flow"; },
      pushCurrentBranch() { pushes.push("feature/new-pr-flow"); return "feature/new-pr-flow"; },
      createPullRequest(_, options) { prs.push(options); },
    }),
    async generatePullRequestDraft(_, request, __, options) {
      requests.push(request.baseBranch);
      options?.onUsage?.({
        promptTokens: 90,
        completionTokens: 30,
        totalTokens: 120,
        costCredits: 0.00042,
      });
      return {
        title: "feat: improve PR automation flow",
        body: "## Summary\n- Improve generated pull request metadata.\n\n## Testing\n- npm test",
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(pushes, ["feature/new-pr-flow"]);
  assert.deepEqual(requests, ["main"]);
  assert.deepEqual(prs, [{
    base: "main",
    title: "feat: improve PR automation flow",
    body: "## Summary\n- Improve generated pull request metadata.\n\n## Testing\n- npm test",
  }]);
  assert.ok(messages.some((message) => message.includes("Token usage")));
  assert.ok(messages.some((message) => message.includes("Total: 120")));
  assert.ok(messages.some((message) => message.includes("Estimated cost: $0.00042")));
});

test("runCli pr supports regeneration with feedback", async () => {
  const actionQueue: Array<"regenerate" | "create"> = ["regenerate", "create"];
  const feedbackValues: string[] = [];
  const prs: Array<{ title?: string; body?: string }> = [];

  const exitCode = await runCli(["pr"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key",
    },
    output: makeOutput(),
    prompt: {
      async confirm() {
        return true;
      },
      async choosePrAction() {
        return actionQueue.shift() ?? "create";
      },
      async input() {
        return "focus more on test coverage";
      },
    },
    gitClient: makeGitClient({
      getCurrentBranch() { return "feature/regenerate-pr"; },
      createPullRequest(_, options) { prs.push(options); },
    }),
    async generatePullRequestDraft(_, request) {
      feedbackValues.push(request.regenerateFeedback ?? "");
      if (feedbackValues.length === 1) {
        return {
          title: "feat: first draft title",
          body: "## Summary\n- initial draft",
        };
      }

      return {
        title: "feat: improved draft title",
        body: "## Summary\n- improved draft\n\n## Testing\n- npm test",
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(feedbackValues, ["", "focus more on test coverage"]);
  assert.deepEqual(prs, [{
    base: "main",
    title: "feat: improved draft title",
    body: "## Summary\n- improved draft\n\n## Testing\n- npm test",
  }]);
});

test("runCli gitignore writes ignore rules", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "autogit-gitignore-cli-"));
  fs.writeFileSync(path.join(tempDir, "package.json"), '{"name":"demo"}');
  const { messages, output } = makeMessageOutput();

  const exitCode = await runCli(["gitignore", "--yes"], {
    cwd: tempDir,
    output,
  });

  assert.equal(exitCode, 0);
  const gitignore = fs.readFileSync(path.join(tempDir, ".gitignore"), "utf8");
  assert.match(gitignore, /# Node\.js/);
  assert.match(gitignore, /node_modules\//);
  assert.ok(messages.some((message) => message.includes("Updated .gitignore")));
});

test("runCli publish creates a private GitHub repo by default", async () => {
  const publishCalls: Array<{ name?: string; visibility: "public" | "private" }> = [];
  const { messages, output } = makeMessageOutput();

  const exitCode = await runCli(["publish", "demo-repo", "--yes"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "unused-for-publish",
    },
    output,
    gitClient: makeGitClient({
      getStatusSummary() { return makeStatusSummary({ stagedCount: 0, clean: true }); },
      hasWorkingTreeChanges() { return false; },
      publishRepository(_, options) { publishCalls.push(options); return options.name ?? "repo"; },
    }),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(publishCalls, [{ name: "demo-repo", visibility: "private" }]);
  assert.ok(messages.some((message) => message.includes("Published GitHub repository: demo-repo")));
});
