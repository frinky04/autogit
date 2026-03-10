import { emitSuccess } from "../output.ts";
import { renderCommandHeader, renderStatus } from "../render.ts";
import type { AppConfig, CliContext } from "../types.ts";
import { runCommitFlow } from "./commit.ts";

export async function runGuideFlow(
  ctx: CliContext,
  config: AppConfig,
): Promise<void> {
  const status = ctx.git.getStatusSummary(ctx.cwd);
  renderStatus(ctx.output, status);

  if (status.clean) {
    emitSuccess(ctx.output, "Nothing to do. Working tree is clean.");
    return;
  }

  const result = await runCommitFlow(ctx, {
    config,
    model: config.model,
    reasoningMode: config.reasoningMode,
    autoConfirm: false,
    stageAll: false,
  });

  let pushed = result.pushed;
  const currentBranch = ctx.git.getCurrentBranch(ctx.cwd);

  if (!pushed && (await ctx.prompt.confirm("Push the current branch now?"))) {
    const branchName = ctx.git.pushCurrentBranch(ctx.cwd);
    pushed = true;
    emitSuccess(ctx.output, `Pushed branch: ${branchName}`);
  }

  if (
    pushed &&
    shouldOfferPullRequest(currentBranch, config.defaultBaseBranch) &&
    (await ctx.prompt.confirm("Create a pull request now?"))
  ) {
    renderCommandHeader(ctx.output, "AutoGit PR", [
      { label: "Branch", value: currentBranch },
      { label: "Base", value: config.defaultBaseBranch ?? "(gh default)" },
      { label: "Title", value: "(gh prompt)" },
    ]);
    ctx.git.createPullRequest(ctx.cwd, {
      base: config.defaultBaseBranch,
    });
    emitSuccess(ctx.output, "Pull request created via gh.");
  }
}

function shouldOfferPullRequest(currentBranch: string, baseBranch?: string): boolean {
  if (baseBranch && currentBranch === baseBranch) {
    return false;
  }
  if (!baseBranch && (currentBranch === "main" || currentBranch === "master")) {
    return false;
  }
  return true;
}
