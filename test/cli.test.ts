import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { UserError } from "../src/errors.ts";
import { runCli } from "../src/cli.ts";
import type { GitClient } from "../src/types.ts";

function makeGitClient(overrides: Partial<GitClient> = {}): GitClient {
  return {
    ensureGitAvailable() {},
    resolveRepoRoot() { return "/repo"; },
    getCurrentBranch() { return "main"; },
    getStagedFiles() { return ["file.txt"]; },
    getStatusSummary() { return makeStatusSummary(); },
    getStagedDiff() { return "diff --git a/file.txt b/file.txt"; },
    hasWorkingTreeChanges() { return true; },
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
  const messages: string[] = [];
  const commits: string[] = [];
  const streamed: string[] = [];
  let streamEnded = 0;
  let spinnerStarted = 0;
  let spinnerStopped = 0;

  const exitCode = await runCli(["commit", "--yes"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key",
    },
    output: {
      info(message: string) {
        messages.push(message);
      },
      error(message: string) {
        messages.push(message);
      },
      stream(chunk: string) {
        streamed.push(chunk);
      },
      endStream() {
        streamEnded += 1;
      },
      startSpinner() {
        spinnerStarted += 1;
      },
      stopSpinner() {
        spinnerStopped += 1;
      },
    },
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
      return "feat: add hello file";
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(commits, ["feat: add hello file"]);
  assert.deepEqual(streamed, ["feat: ", "add hello file"]);
  assert.equal(streamEnded, 1);
  assert.equal(spinnerStarted, 1);
  assert.equal(spinnerStopped, 2);
  assert.ok(messages.includes("AutoGit"));
  assert.ok(messages.some((message) => message.includes("Branch: main")));
  assert.ok(messages.some((message) => message.includes("Suggested commit message:")));
  assert.ok(messages.some((message) => message.includes("Committed changes.")));
});

test("runCli retries with auto reasoning when provider rejects no-reasoning", async () => {
  const messages: string[] = [];
  const commits: string[] = [];
  const reasoningModes: string[] = [];

  const exitCode = await runCli(["commit", "--no-reasoning", "--yes"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key",
    },
    output: {
      info(message: string) {
        messages.push(message);
      },
      error(message: string) {
        messages.push(message);
      },
    },
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
  const messages: string[] = [];
  const commits: string[] = [];
  let staged = false;
  const actionCalls: string[] = [];

  const exitCode = await runCli(["commit"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key",
    },
    output: {
      info(message: string) {
        messages.push(message);
      },
      error(message: string) {
        messages.push(message);
      },
    },
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
    output: {
      info() {},
      error() {},
    },
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

test("runCli commit can commit and push from the action prompt", async () => {
  const messages: string[] = [];
  const commits: string[] = [];
  const pushes: string[] = [];

  const exitCode = await runCli(["commit"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key",
    },
    output: {
      info(message: string) {
        messages.push(message);
      },
      error(message: string) {
        messages.push(message);
      },
    },
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
    output: {
      info() {},
      error() {},
    },
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
  const messages: string[] = [];

  const exitCode = await runCli(["status"], {
    cwd: "/repo",
    output: {
      info(message: string) {
        messages.push(message);
      },
      error(message: string) {
        messages.push(message);
      },
    },
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

test("runCli guide can commit, push, and create PR", async () => {
  const messages: string[] = [];
  const commits: string[] = [];
  const prs: Array<{ base?: string }> = [];
  const pushes: string[] = [];

  const exitCode = await runCli(["guide"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key",
    },
    output: {
      info(message: string) {
        messages.push(message);
      },
      error(message: string) {
        messages.push(message);
      },
    },
    prompt: {
      async confirm(message: string) {
        if (message.includes("Create a pull request now?")) {
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
      async input() {
        return "";
      },
    },
    gitClient: makeGitClient({
      getCurrentBranch() { return "feature/guide-flow"; },
      getStatusSummary() {
        return makeStatusSummary({
          branchName: "feature/guide-flow", upstream: "origin/feature/guide-flow",
          unstagedCount: 1, clean: false,
        });
      },
      commitWithMessage(_, message) { commits.push(message); },
      pushCurrentBranch() { pushes.push("feature/guide-flow"); return "feature/guide-flow"; },
      createPullRequest(_, options) { prs.push(options); },
    }),
    async generateCommitMessage() {
      return "feat: guided commit";
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(commits, ["feat: guided commit"]);
  assert.deepEqual(pushes, ["feature/guide-flow"]);
  assert.deepEqual(prs, [{ base: undefined }]);
  assert.ok(messages.some((message) => message.includes("AutoGit Status")));
  assert.ok(messages.some((message) => message.includes("Pull request created via gh.")));
});

test("runCli guide skips PR prompt on main branch", async () => {
  const prompts: string[] = [];
  const prs: Array<{ base?: string }> = [];

  const exitCode = await runCli(["guide"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key",
    },
    output: {
      info() {},
      error() {},
    },
    prompt: {
      async confirm(message: string) {
        prompts.push(message);
        return false;
      },
      async chooseCommitAction() {
        return "push";
      },
      async editMessage(message) {
        return message;
      },
      async input() {
        return "";
      },
    },
    gitClient: makeGitClient({
      getStatusSummary() {
        return makeStatusSummary({ branchName: "main", upstream: "origin/main", clean: false });
      },
      createPullRequest(_, options) { prs.push(options); },
    }),
    async generateCommitMessage() {
      return "feat: guided commit";
    },
  });

  assert.equal(exitCode, 0);
  assert.ok(!prompts.includes("Create a pull request now?"));
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
    output: {
      info() {},
      error() {},
    },
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
  const output: string[] = [];
  const exitCode = await runCli(["push"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "unused-for-push",
    },
    output: {
      info(message: string) {
        output.push(message);
      },
      error(message: string) {
        output.push(message);
      },
    },
    gitClient: makeGitClient({
      getStatusSummary() { return makeStatusSummary({ stagedCount: 0, clean: true }); },
      hasWorkingTreeChanges() { return false; },
      pushCurrentBranch() { return "feature/pushed"; },
    }),
  });

  assert.equal(exitCode, 0);
  assert.ok(output.some((message) => message.includes("Pushed branch")));
});

test("runCli gitignore writes ignore rules", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "autogit-gitignore-cli-"));
  fs.writeFileSync(path.join(tempDir, "package.json"), '{"name":"demo"}');
  const messages: string[] = [];

  const exitCode = await runCli(["gitignore", "--yes"], {
    cwd: tempDir,
    output: {
      info(message: string) {
        messages.push(message);
      },
      error(message: string) {
        messages.push(message);
      },
    },
  });

  assert.equal(exitCode, 0);
  const gitignore = fs.readFileSync(path.join(tempDir, ".gitignore"), "utf8");
  assert.match(gitignore, /# Node\.js/);
  assert.match(gitignore, /node_modules\//);
  assert.ok(messages.some((message) => message.includes("Updated .gitignore")));
});

test("runCli publish creates a private GitHub repo by default", async () => {
  const messages: string[] = [];
  const publishCalls: Array<{ name?: string; visibility: "public" | "private" }> = [];

  const exitCode = await runCli(["publish", "demo-repo", "--yes"], {
    cwd: "/repo",
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "unused-for-publish",
    },
    output: {
      info(message: string) {
        messages.push(message);
      },
      error(message: string) {
        messages.push(message);
      },
    },
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
