import { spawnSync } from "node:child_process";
import path from "node:path";

import { UserError } from "./errors.ts";
import type { GitClient, GitStatusSummary } from "./types.ts";

export function ensureGitAvailable(cwd: string): void {
  runCommand("git", ["--version"], cwd);
}

export function resolveRepoRoot(cwd: string): string {
  const result = runCommand("git", ["rev-parse", "--show-toplevel"], cwd);
  return path.resolve(cwd, result.stdout.trim());
}

export function getCurrentBranch(cwd: string): string {
  const branchName = runCommand("git", ["branch", "--show-current"], cwd).stdout.trim();
  if (branchName) {
    return branchName;
  }

  // Detached HEAD: return short commit id.
  return runCommand("git", ["rev-parse", "--short", "HEAD"], cwd).stdout.trim();
}

export function getStagedFiles(cwd: string): string[] {
  return runCommand("git", ["diff", "--cached", "--name-only"], cwd)
    .stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function getStatusSummary(cwd: string): GitStatusSummary {
  const output = runCommand("git", ["status", "--porcelain=2", "--branch"], cwd).stdout;
  const summary: GitStatusSummary = {
    branchName: "",
    upstream: undefined,
    ahead: 0,
    behind: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    clean: true,
  };

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      continue;
    }

    if (line.startsWith("# ")) {
      if (line.startsWith("# branch.head ")) {
        summary.branchName = line.slice("# branch.head ".length);
      } else if (line.startsWith("# branch.upstream ")) {
        summary.upstream = line.slice("# branch.upstream ".length);
      } else if (line.startsWith("# branch.ab ")) {
        const match = /# branch\.ab \+(\d+) \-(\d+)/.exec(line);
        if (match) {
          summary.ahead = Number(match[1]);
          summary.behind = Number(match[2]);
        }
      }
      continue;
    }

    if (line.startsWith("? ")) {
      summary.untrackedCount += 1;
      continue;
    }

    if (line.startsWith("! ")) {
      continue;
    }

    if (!(line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u "))) {
      continue;
    }

    const statusCode = line[2] ?? ".";
    const worktreeCode = line[3] ?? ".";
    if (statusCode !== "." && statusCode !== " ") {
      summary.stagedCount += 1;
    }
    if (worktreeCode !== "." && worktreeCode !== " ") {
      summary.unstagedCount += 1;
    }
  }

  summary.clean =
    summary.stagedCount === 0 &&
    summary.unstagedCount === 0 &&
    summary.untrackedCount === 0;

  return summary;
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

export function getDefaultBaseBranch(cwd: string): string | undefined {
  const remoteHead = runCommandOptional(
    "git",
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    cwd,
  );

  if (remoteHead?.status === 0) {
    const ref = remoteHead.stdout.trim();
    const prefix = "origin/";
    if (ref.startsWith(prefix)) {
      const branchName = ref.slice(prefix.length).trim();
      if (branchName) {
        return branchName;
      }
    }
  }

  for (const candidate of ["main", "master"]) {
    if (refExists(cwd, candidate) || refExists(cwd, `origin/${candidate}`)) {
      return candidate;
    }
  }

  return undefined;
}

export function getBranchDiff(cwd: string, baseBranch: string): string {
  const baseRef = resolveBaseRef(cwd, baseBranch);
  return runCommand(
    "git",
    ["diff", "--no-ext-diff", "--unified=3", "--minimal", `${baseRef}...HEAD`],
    cwd,
  ).stdout;
}

export function getCommitLog(cwd: string, baseBranch: string): string {
  const baseRef = resolveBaseRef(cwd, baseBranch);
  return runCommand(
    "git",
    ["log", "--no-merges", "--pretty=format:%h %s", "--reverse", `${baseRef}..HEAD`],
    cwd,
  ).stdout;
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
  getStatusSummary,
  getStagedDiff,
  hasWorkingTreeChanges,
  getDefaultBaseBranch,
  getBranchDiff,
  getCommitLog,
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

function refExists(cwd: string, ref: string): boolean {
  const result = runCommandOptional("git", ["rev-parse", "--verify", "--quiet", ref], cwd);
  return Boolean(result && result.status === 0);
}

function resolveBaseRef(cwd: string, baseBranch: string): string {
  if (refExists(cwd, baseBranch)) {
    return baseBranch;
  }

  const remoteRef = `origin/${baseBranch}`;
  if (refExists(cwd, remoteRef)) {
    return remoteRef;
  }

  throw new UserError(`Base branch not found locally or on origin: ${baseBranch}`);
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

function runCommandOptional(command: string, args: string[], cwd: string, input?: string) {
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

  return result;
}
