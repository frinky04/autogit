import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { UserError } from "../src/errors.ts";
import { runCli } from "../src/cli.ts";

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
    gitClient: {
      ensureGitAvailable() {},
      resolveRepoRoot() {
        return "/repo";
      },
      getCurrentBranch() {
        return "main";
      },
      getStagedFiles() {
        return ["file.txt"];
      },
      getStagedDiff() {
        return "diff --git a/file.txt b/file.txt";
      },
      hasWorkingTreeChanges() {
        return true;
      },
      stageAllChanges() {},
      commitWithMessage(_, message) {
        commits.push(message);
      },
      switchToNewBranch() {},
      pushCurrentBranch() {
        return "main";
      },
      createPullRequest() {},
      publishRepository() {
        return "repo";
      },
    },
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
    gitClient: {
      ensureGitAvailable() {},
      resolveRepoRoot() {
        return "/repo";
      },
      getCurrentBranch() {
        return "main";
      },
      getStagedFiles() {
        return ["file.txt"];
      },
      getStagedDiff() {
        return "diff --git a/file.txt b/file.txt";
      },
      hasWorkingTreeChanges() {
        return true;
      },
      stageAllChanges() {},
      commitWithMessage(_, message) {
        commits.push(message);
      },
      switchToNewBranch() {},
      pushCurrentBranch() {
        return "main";
      },
      createPullRequest() {},
      publishRepository() {
        return "repo";
      },
    },
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
    gitClient: {
      ensureGitAvailable() {},
      resolveRepoRoot() {
        return "/repo";
      },
      getCurrentBranch() {
        return "main";
      },
      getStagedFiles() {
        return ["file.txt"];
      },
      getStagedDiff() {
        return staged ? "diff --git a/file.txt b/file.txt" : "";
      },
      hasWorkingTreeChanges() {
        return true;
      },
      stageAllChanges() {
        staged = true;
      },
      commitWithMessage(_, message) {
        commits.push(message);
      },
      switchToNewBranch() {},
      pushCurrentBranch() {
        return "main";
      },
      createPullRequest() {},
      publishRepository() {
        return "repo";
      },
    },
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
    gitClient: {
      ensureGitAvailable() {},
      resolveRepoRoot() {
        return "/repo";
      },
      getCurrentBranch() {
        return "main";
      },
      getStagedFiles() {
        return ["file.txt"];
      },
      getStagedDiff() {
        return staged ? "diff --git a/file.txt b/file.txt" : "";
      },
      hasWorkingTreeChanges() {
        return true;
      },
      stageAllChanges() {
        staged = true;
      },
      commitWithMessage(_, message) {
        commits.push(message);
      },
      switchToNewBranch() {},
      pushCurrentBranch() {
        return "main";
      },
      createPullRequest() {},
      publishRepository() {
        return "repo";
      },
    },
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
    gitClient: {
      ensureGitAvailable() {},
      resolveRepoRoot() {
        return "/repo";
      },
      getCurrentBranch() {
        return "main";
      },
      getStagedFiles() {
        return ["file.txt"];
      },
      getStagedDiff() {
        return "diff --git a/file.txt b/file.txt";
      },
      hasWorkingTreeChanges() {
        return true;
      },
      stageAllChanges() {},
      commitWithMessage(_, message) {
        commits.push(message);
      },
      switchToNewBranch() {},
      pushCurrentBranch() {
        pushes.push("main");
        return "main";
      },
      createPullRequest() {},
      publishRepository() {
        return "repo";
      },
    },
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
    },
    gitClient: {
      ensureGitAvailable() {},
      resolveRepoRoot() {
        return "/repo";
      },
      getCurrentBranch() {
        return "main";
      },
      getStagedFiles() {
        return ["file.txt"];
      },
      getStagedDiff() {
        return "diff --git a/file.txt b/file.txt";
      },
      hasWorkingTreeChanges() {
        return true;
      },
      stageAllChanges() {},
      commitWithMessage(_, message) {
        commits.push(message);
      },
      switchToNewBranch() {},
      pushCurrentBranch() {
        return "main";
      },
      createPullRequest() {},
      publishRepository() {
        return "repo";
      },
    },
    async generateCommitMessage() {
      const value = generated.length === 0 ? "feat: first draft" : "feat: second draft";
      generated.push(value);
      return value;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(generated, ["feat: first draft", "feat: second draft"]);
  assert.deepEqual(commits, ["feat: edited message"]);
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
    gitClient: {
      ensureGitAvailable() {},
      resolveRepoRoot() {
        return "/repo";
      },
      getCurrentBranch() {
        return "main";
      },
      getStagedFiles() {
        return [];
      },
      getStagedDiff() {
        return "";
      },
      hasWorkingTreeChanges() {
        return false;
      },
      stageAllChanges() {},
      commitWithMessage() {},
      switchToNewBranch() {},
      pushCurrentBranch() {
        return "feature/pushed";
      },
      createPullRequest() {},
      publishRepository() {
        return "repo";
      },
    },
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
    gitClient: {
      ensureGitAvailable() {},
      resolveRepoRoot() {
        return "/repo";
      },
      getCurrentBranch() {
        return "main";
      },
      getStagedFiles() {
        return [];
      },
      getStagedDiff() {
        return "";
      },
      hasWorkingTreeChanges() {
        return false;
      },
      stageAllChanges() {},
      commitWithMessage() {},
      switchToNewBranch() {},
      pushCurrentBranch() {
        return "main";
      },
      createPullRequest() {},
      publishRepository(_, options) {
        publishCalls.push(options);
        return options.name ?? "repo";
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(publishCalls, [{ name: "demo-repo", visibility: "private" }]);
  assert.ok(messages.some((message) => message.includes("Published GitHub repository: demo-repo")));
});
