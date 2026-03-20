import type { GitStatusSummary, OutputWriter, PullRequestDraft, TokenUsage } from "./types.ts";
import { emitSuccess, emitWarn } from "./output.ts";

export function renderCommandHeader(
  output: OutputWriter,
  title: string,
  items: Array<{ label: string; value: string }>,
): void {
  output.headline(title);
  for (const item of items) {
    output.keyValue(item.label, item.value);
  }
  output.info("");
}

export function renderStatus(output: OutputWriter, status: GitStatusSummary): void {
  renderCommandHeader(output, "AutoGit Status", [
    { label: "Branch", value: status.branchName },
    { label: "Upstream", value: status.upstream ?? "(none)" },
    { label: "Ahead", value: String(status.ahead) },
    { label: "Behind", value: String(status.behind) },
  ]);

  const content = [
    `Staged:    ${status.stagedCount}`,
    `Unstaged:  ${status.unstagedCount}`,
    `Untracked: ${status.untrackedCount}`,
  ].join("\n");

  output.box("Working tree", content);
  output.info("");

  if (status.clean) {
    emitSuccess(output, "Working tree is clean.");
  } else {
    emitWarn(output, "Pending changes detected.");
  }
}

export function renderCommitMessage(output: OutputWriter, message: string): void {
  output.box("Suggested commit message", message);
  output.info("");
}

export function renderCommitActions(output: OutputWriter): void {
  output.actionLine([
    { key: "Enter", label: "Commit" },
    { key: "p", label: "Commit & Push" },
    { key: "b", label: "New Branch" },
    { key: "e", label: "Edit" },
    { key: "r", label: "Regenerate" },
    { key: "c", label: "Cancel" },
  ]);
}

export function renderPullRequestDraft(output: OutputWriter, draft: PullRequestDraft): void {
  output.box("Suggested PR title", draft.title);
  output.info("");
  output.box("Suggested PR description", draft.body);
  output.info("");
}

export function renderPrActions(output: OutputWriter): void {
  output.actionLine([
    { key: "Enter", label: "Create PR" },
    { key: "r", label: "Regenerate" },
    { key: "c", label: "Cancel" },
  ]);
}

export function renderTokenUsage(output: OutputWriter, usage: TokenUsage | undefined): void {
  if (!usage) {
    return;
  }

  const lines = [
    `Prompt: ${usage.promptTokens}`,
    `Completion: ${usage.completionTokens}`,
    `Total: ${usage.totalTokens}`,
  ];
  if (usage.costCredits !== undefined) {
    lines.push(`Estimated cost: $${formatCostCredits(usage.costCredits)}`);
  }

  output.box(
    "Token usage",
    lines.join("\n"),
  );
  output.info("");
}

function formatCostCredits(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }

  return value.toFixed(8).replace(/\.?0+$/, "");
}
