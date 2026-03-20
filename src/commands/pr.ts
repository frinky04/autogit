import { requireApiKey } from "../config.ts";
import { UserError } from "../errors.ts";
import { generatePullRequestDraftWithFallback } from "../openrouter.ts";
import { emitSuccess, emitWarn } from "../output.ts";
import { renderCommandHeader, renderPrActions, renderPullRequestDraft, renderTokenUsage } from "../render.ts";
import type { AppConfig, CliContext, PrAction, PullRequestDraftRequest, ReasoningMode, TokenUsage } from "../types.ts";

const DEFAULT_PR_SYSTEM_PROMPT =
  "You write clear, reviewer-friendly GitHub pull request drafts. Return strict JSON with keys title and body only. The body should be concise markdown with practical context and test notes.";

export async function runPrFlow(
  ctx: CliContext,
  options: {
    config: AppConfig;
    model: string;
    reasoningMode: ReasoningMode;
    autoConfirm: boolean;
    baseBranch?: string;
  },
): Promise<void> {
  const config = requireApiKey(options.config);
  const repoRoot = ctx.git.resolveRepoRoot(ctx.cwd);
  const branchName = ctx.git.getCurrentBranch(ctx.cwd);
  const baseBranch = resolveBaseBranch(ctx, options.baseBranch ?? options.config.defaultBaseBranch);

  if (branchName === baseBranch) {
    throw new UserError(
      `Current branch "${branchName}" matches base branch "${baseBranch}". Switch to a feature branch before opening a PR.`,
    );
  }

  renderCommandHeader(ctx.output, "AutoGit PR", [
    { label: "Branch", value: branchName },
    { label: "Base", value: baseBranch },
    { label: "Model", value: options.model },
  ]);

  const status = ctx.git.getStatusSummary(ctx.cwd);
  if (!status.clean) {
    emitWarn(
      ctx.output,
      "Uncommitted changes detected. PR generation uses committed branch history only.",
    );

    if (!options.autoConfirm) {
      const proceed = await ctx.prompt.confirm("Continue with uncommitted changes present?", {
        defaultValue: true,
      });
      if (!proceed) {
        throw new UserError("Pull request creation aborted.");
      }
    }

    ctx.output.info("");
  }

  ctx.output.info("Pushing current branch.");
  const pushedBranch = ctx.git.pushCurrentBranch(ctx.cwd);
  emitSuccess(ctx.output, `Pushed branch: ${pushedBranch}`);
  ctx.output.info("");

  const diff = ctx.git.getBranchDiff(ctx.cwd, baseBranch);
  if (!diff.trim()) {
    throw new UserError(`No committed differences found between ${baseBranch} and ${branchName}.`);
  }

  const commitLog = ctx.git.getCommitLog(ctx.cwd, baseBranch);
  ctx.output.startSpinner("Generating PR draft");
  let tokenUsage: TokenUsage | undefined;

  const request: PullRequestDraftRequest = {
    model: options.model,
    systemPrompt: DEFAULT_PR_SYSTEM_PROMPT,
    diff,
    repoRoot,
    branchName,
    baseBranch,
    commitLog,
    reasoningMode: options.reasoningMode,
  };

  const draft = await generatePullRequestDraftWithFallback(
    config,
    request,
    ctx.fetchImpl,
    ctx.generatePullRequestDraft,
    ctx.output,
    {
      onUsage(usage) {
        tokenUsage = usage;
      },
    },
  );

  ctx.output.stopSpinner();
  renderPullRequestDraft(ctx.output, draft);
  renderTokenUsage(ctx.output, tokenUsage);

  if (options.autoConfirm) {
    ctx.git.createPullRequest(ctx.cwd, {
      base: baseBranch,
      title: draft.title,
      body: draft.body,
    });
    emitSuccess(ctx.output, "Pull request created via gh.");
    return;
  }

  renderPrActions(ctx.output);
  const action = await choosePrAction(ctx);

  if (action === "cancel") {
    throw new UserError("Pull request creation aborted.");
  }

  ctx.git.createPullRequest(ctx.cwd, {
    base: baseBranch,
    title: draft.title,
    body: draft.body,
  });
  emitSuccess(ctx.output, "Pull request created via gh.");
}

function resolveBaseBranch(ctx: CliContext, configuredBase?: string): string {
  const base = configuredBase ?? ctx.git.getDefaultBaseBranch(ctx.cwd);
  if (!base) {
    throw new UserError(
      "Unable to determine a base branch. Provide --base or set AUTOGIT_DEFAULT_BASE_BRANCH.",
    );
  }
  return base;
}

async function choosePrAction(ctx: CliContext): Promise<PrAction> {
  if (ctx.prompt.choosePrAction) {
    return ctx.prompt.choosePrAction("");
  }
  const confirmed = await ctx.prompt.confirm("Create pull request with this draft?");
  return confirmed ? "create" : "cancel";
}
