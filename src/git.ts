import { spawnSync } from "node:child_process";
import path from "node:path";

import { UserError } from "./errors.ts";
import type { GitClient } from "./types.ts";

export function ensureGitAvailable(cwd: string): void {
  runCommand("git", ["--version"], cwd);
}

export function resolveRepoRoot(cwd: string): string {
  const result = runCommand("git", ["rev-parse", "--show-toplevel"], cwd);
  return path.resolve(cwd, result.stdout.trim());
}

export function getCurrentBranch(cwd: string): string {
  return runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd).stdout.trim();
}

export function getStagedFiles(cwd: string): string[] {
  return runCommand("git", ["diff", "--cached", "--name-only"], cwd)
    .stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function getStagedDiff(cwd: string): string {
  return runCommand(
    "git",
    ["diff", "--cached", "--no-ext-diff", "--unified=3", "--minimal"],
    cwd,
  ).stdout;
}

export function hasWorkingTreeChanges(cwd: string): boolean {
  return runCommand("git", ["status", "--porcelain"], cwd).stdout.trim().length > 0;
}

export function stageAllChanges(cwd: string): void {
  runCommand("git", ["add", "--all"], cwd);
}

export function commitWithMessage(cwd: string, message: string): void {
  runCommand("git", ["commit", "-F", "-"], cwd, message);
}

export function switchToNewBranch(cwd: string, branchName: string): void {
  runCommand("git", ["switch", "-c", branchName], cwd);
}

export function pushCurrentBranch(cwd: string): string {
  const branchName = getCurrentBranch(cwd);

  if (hasUpstream(cwd)) {
    runCommand("git", ["push"], cwd);
    return branchName;
  }

  runCommand("git", ["push", "--set-upstream", "origin", branchName], cwd);
  return branchName;
}

export function createPullRequest(
  cwd: string,
  options: {
    base?: string;
    title?: string;
    body?: string;
  },
): void {
  const args = ["pr", "create"];

  if (options.base) {
    args.push("--base", options.base);
  }

  if (options.title) {
    args.push("--title", options.title);
  }

  if (options.body) {
    args.push("--body", options.body);
  }

  runCommand("gh", args, cwd);
}

export function publishRepository(
  cwd: string,
  options: {
    name?: string;
    visibility: "public" | "private";
  },
): string {
  const repoRoot = resolveRepoRoot(cwd);
  const repoName = options.name ?? path.basename(repoRoot);
  const args = ["repo", "create"];

  if (options.name) {
    args.push(options.name);
  }

  args.push(`--${options.visibility}`, "--source", repoRoot, "--remote", "origin", "--push");
  runCommand("gh", args, repoRoot);

  return repoName;
}

export const gitClient: GitClient = {
  ensureGitAvailable,
  resolveRepoRoot,
  getCurrentBranch,
  getStagedFiles,
  getStagedDiff,
  hasWorkingTreeChanges,
  stageAllChanges,
  commitWithMessage,
  switchToNewBranch,
  pushCurrentBranch,
  createPullRequest,
  publishRepository,
};

function hasUpstream(cwd: string): boolean {
  const result = spawnSync(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  return result.status === 0;
}

function runCommand(command: string, args: string[], cwd: string, input?: string) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new UserError(`Required command not found on PATH: ${command}`);
    }

    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    const message = stderr || stdout || `${command} exited with status ${result.status}`;
    throw new UserError(message);
  }

  return result;
}
