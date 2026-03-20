import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { getCurrentBranch, getStatusSummary } from "../src/git.ts";

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
  }

  return result.stdout.trim();
}

test("getCurrentBranch works for repos with no commits", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "autogit-git-test-"));

  try {
    runGit(tempDir, ["init", "-q"]);

    const expected = runGit(tempDir, ["branch", "--show-current"]);
    const branchName = getCurrentBranch(tempDir);

    assert.equal(branchName, expected);
    assert.notEqual(branchName, "");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("getCurrentBranch returns short commit hash in detached HEAD", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "autogit-git-test-"));

  try {
    runGit(tempDir, ["init", "-q"]);
    fs.writeFileSync(path.join(tempDir, "file.txt"), "hello\n", "utf8");
    runGit(tempDir, ["add", "file.txt"]);
    runGit(tempDir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init"]);
    runGit(tempDir, ["checkout", "-q", "--detach"]);

    const expected = runGit(tempDir, ["rev-parse", "--short", "HEAD"]);
    const branchName = getCurrentBranch(tempDir);

    assert.equal(branchName, expected);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("getStatusSummary reports clean for branch metadata-only porcelain output", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "autogit-git-test-"));

  try {
    runGit(tempDir, ["init", "-q"]);
    fs.writeFileSync(path.join(tempDir, "file.txt"), "hello\n", "utf8");
    runGit(tempDir, ["add", "file.txt"]);
    runGit(tempDir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init"]);

    const summary = getStatusSummary(tempDir);

    assert.equal(summary.clean, true);
    assert.equal(summary.stagedCount, 0);
    assert.equal(summary.unstagedCount, 0);
    assert.equal(summary.untrackedCount, 0);
    assert.notEqual(summary.branchName, "");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("getStatusSummary counts staged, unstaged, and untracked changes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "autogit-git-test-"));

  try {
    runGit(tempDir, ["init", "-q"]);
    fs.writeFileSync(path.join(tempDir, "tracked.txt"), "base\n", "utf8");
    runGit(tempDir, ["add", "tracked.txt"]);
    runGit(tempDir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init"]);

    fs.writeFileSync(path.join(tempDir, "tracked.txt"), "base\nworktree\n", "utf8");
    fs.writeFileSync(path.join(tempDir, "staged-only.txt"), "staged\n", "utf8");
    runGit(tempDir, ["add", "staged-only.txt"]);
    fs.writeFileSync(path.join(tempDir, "untracked.txt"), "untracked\n", "utf8");

    const summary = getStatusSummary(tempDir);

    assert.equal(summary.clean, false);
    assert.equal(summary.stagedCount, 1);
    assert.equal(summary.unstagedCount, 1);
    assert.equal(summary.untrackedCount, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
