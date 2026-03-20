import { requireApiKey } from "../config.ts";
import { UserError } from "../errors.ts";
import { runPrFlow } from "./pr.ts";
import { generateCommitMessageWithFallback } from "../openrouter.ts";
import { emitSuccess } from "../output.ts";
import { renderCommandHeader, renderCommitActions, renderCommitMessage, renderTokenUsage } from "../render.ts";
import type { AppConfig, CliContext, CommitAction, OpenRouterRequest, ReasoningMode, TokenUsage } from "../types.ts";

export async function runCommitFlow(
  ctx: CliContext,
  options: {
    config: AppConfig;
    model: string;
    reasoningMode: ReasoningMode;
    autoConfirm: boolean;
    stageAll: boolean;
  },
): Promise<void> {
  const diff = await prepareCommitDiff(ctx, options.stageAll, options.autoConfirm);

  const repoRoot = ctx.git.resolveRepoRoot(ctx.cwd);
  const branchName = ctx.git.getCurrentBranch(ctx.cwd);
  const stagedFiles = ctx.git.getStagedFiles(ctx.cwd);
  const config = requireApiKey(options.config);

  renderCommandHeader(ctx.output, "AutoGit", [
    { label: "Branch", value: branchName },
    { label: "Staged", value: `${stagedFiles.length} file${stagedFiles.length === 1 ? "" : "s"}` },
    { label: "Model", value: options.model },
  ]);

  let message = "";
  let regenerateFeedback: string | undefined;

  while (true) {
    ctx.output.startSpinner("Generating commit message");
    let tokenUsage: TokenUsage | undefined;

    const request: OpenRouterRequest = {
      model: options.model,
      systemPrompt: config.systemPrompt,
      diff,
      repoRoot,
      reasoningMode: options.reasoningMode,
      regenerateFeedback,
    };

    let streamedAny = false;
    message = await generateCommitMessageWithFallback(
      config,
      request,
      ctx.fetchImpl,
      ctx.generateCommitMessage,
      ctx.output,
      {
        onToken(token) {
          if (!streamedAny) {
            ctx.output.stopSpinner();
            ctx.output.info("");
            ctx.output.headline("Suggested commit message");
            ctx.output.info("");
          }
          streamedAny = true;
          ctx.output.stream(token);
        },
        onUsage(usage) {
          tokenUsage = usage;
        },
      },
    );

    ctx.output.stopSpinner();

    if (streamedAny) {
      ctx.output.endStream();
      ctx.output.info("");
    } else {
      renderCommitMessage(ctx.output, message);
    }
    renderTokenUsage(ctx.output, tokenUsage);

    if (options.autoConfirm) {
      ctx.git.commitWithMessage(ctx.cwd, message);
      emitSuccess(ctx.output, "Committed changes.");
      return;
    }

    const result = await promptForAction(ctx, message);

    if (result.action === "regenerate") {
      regenerateFeedback = await requestRegenerateFeedback(ctx);
      continue;
    }

    const pushed = applyCommitAction(result.action, ctx, result.message);

    if (pushed) {
      await offerPullRequest(ctx, {
        config: options.config,
        model: options.model,
        reasoningMode: options.reasoningMode,
      });
    }

    return;
  }
}

async function prepareCommitDiff(
  ctx: CliContext,
  stageAll: boolean,
  autoConfirm: boolean,
): Promise<string> {
  let diff = ctx.git.getStagedDiff(ctx.cwd);
  const hasStagedDiff = diff.trim().length > 0;

  if (!hasStagedDiff && !ctx.git.hasWorkingTreeChanges(ctx.cwd)) {
    throw new UserError("No changes found. Modify files before running autogit commit.");
  }

  const status = ctx.git.getStatusSummary(ctx.cwd);
  const hasUnstagedChanges = status.unstagedCount > 0 || status.untrackedCount > 0;

  if (stageAll) {
    if (hasUnstagedChanges || !hasStagedDiff) {
      return stageAllChangesOrThrow(ctx);
    }

    return diff;
  }

  if (!hasStagedDiff) {
    if (autoConfirm) {
      throw new UserError("No staged changes found. Stage files manually or rerun with --all.");
    }

    const shouldStageAll = await ctx.prompt.confirm(
      "No staged changes found. Stage all tracked and untracked changes?",
    );
    if (!shouldStageAll) {
      throw new UserError("Commit aborted. Stage files manually or rerun with --all.");
    }

    return stageAllChangesOrThrow(ctx);
  }

  if (hasUnstagedChanges && !autoConfirm) {
    const shouldStageAll = await ctx.prompt.confirm(
      "Unstaged or untracked changes found. Stage all tracked and untracked changes?",
    );
    if (shouldStageAll) {
      diff = stageAllChangesOrThrow(ctx);
    }
  }

  return diff;
}

function stageAllChangesOrThrow(ctx: CliContext): string {
  ctx.output.info("Staging all changes.");
  ctx.git.stageAllChanges(ctx.cwd);

  const diff = ctx.git.getStagedDiff(ctx.cwd);
  if (!diff.trim()) {
    throw new UserError("No staged changes found after staging all changes.");
  }

  return diff;
}

async function promptForAction(
  ctx: CliContext,
  message: string,
): Promise<{ action: CommitAction; message: string }> {
  renderCommitActions(ctx.output);
  let action = await chooseCommitAction(ctx);

  if (action === "edit") {
    const edited = await editCommitMessage(ctx, message);
    if (!edited) {
      throw new UserError("Commit aborted.");
    }
    message = edited;
    renderCommitMessage(ctx.output, message);
    renderCommitActions(ctx.output);
    action = await chooseCommitAction(ctx);
  }

  if (action === "branch") {
    action = await switchBranchThenCommit(ctx, message);
  }

  return { action, message };
}

async function chooseCommitAction(ctx: CliContext): Promise<CommitAction> {
  if (ctx.prompt.chooseCommitAction) {
    return ctx.prompt.chooseCommitAction("");
  }
  const confirmed = await ctx.prompt.confirm("Create commit with this message?");
  return confirmed ? "commit" : "cancel";
}

async function editCommitMessage(
  ctx: CliContext,
  message: string,
): Promise<string | null> {
  if (!ctx.prompt.editMessage) {
    return message;
  }
  return ctx.prompt.editMessage(message);
}

async function requestRegenerateFeedback(ctx: CliContext): Promise<string | undefined> {
  if (!ctx.prompt.input) {
    return undefined;
  }
  const value = (await ctx.prompt.input("Feedback for regeneration (optional): ")).trim();
  return value || undefined;
}

async function requestBranchName(ctx: CliContext): Promise<string> {
  if (!ctx.prompt.input) {
    throw new UserError("Branch creation requires interactive input support.");
  }
  const value = (await ctx.prompt.input("New branch name: ")).trim();
  if (!value) {
    throw new UserError("Branch name is required.");
  }
  return value;
}

async function switchBranchThenCommit(
  ctx: CliContext,
  message: string,
): Promise<CommitAction> {
  const branchName = await requestBranchName(ctx);
  ctx.git.switchToNewBranch(ctx.cwd, branchName);
  emitSuccess(ctx.output, `Switched to new branch: ${branchName}`);
  return "commit";
}

function applyCommitAction(
  action: CommitAction,
  ctx: CliContext,
  message: string,
): boolean {
  switch (action) {
    case "commit":
      ctx.git.commitWithMessage(ctx.cwd, message);
      emitSuccess(ctx.output, "Committed changes.");
      return false;
    case "push": {
      ctx.git.commitWithMessage(ctx.cwd, message);
      const branchName = ctx.git.pushCurrentBranch(ctx.cwd);
      emitSuccess(ctx.output, `Committed and pushed branch: ${branchName}`);
      return true;
    }
    case "cancel":
      throw new UserError("Commit aborted.");
    case "branch":
    case "edit":
    case "regenerate":
      throw new UserError(`Unsupported commit action: ${action}`);
  }
}

function isFeatureBranch(branchName: string, baseBranch?: string): boolean {
  if (baseBranch) {
    return branchName !== baseBranch;
  }
  return branchName !== "main" && branchName !== "master";
}

async function offerPullRequest(
  ctx: CliContext,
  options: {
    config: AppConfig;
    model: string;
    reasoningMode: ReasoningMode;
  },
): Promise<void> {
  const currentBranch = ctx.git.getCurrentBranch(ctx.cwd);

  if (!isFeatureBranch(currentBranch, options.config.defaultBaseBranch)) {
    return;
  }

  const wantsPr = await ctx.prompt.confirm("Create a pull request?", { defaultValue: false });
  if (!wantsPr) {
    return;
  }

  try {
    await runPrFlow(ctx, {
      config: options.config,
      model: options.model,
      reasoningMode: options.reasoningMode,
      autoConfirm: false,
      baseBranch: options.config.defaultBaseBranch,
      skipPush: true,
    });
  } catch (error) {
    if (error instanceof UserError && error.message === "Pull request creation aborted.") {
      return;
    }

    throw error;
  }
}
