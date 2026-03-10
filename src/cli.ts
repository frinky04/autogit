import { helpText, parseArgs } from "./args.ts";
import { loadConfig, requireApiKey } from "./config.ts";
import { UserError } from "./errors.ts";
import { gitClient as defaultGitClient } from "./git.ts";
import { runGitignoreFlow } from "./gitignore.ts";
import { generateCommitMessage } from "./openrouter.ts";
import { createConsoleOutput, createConsolePrompt } from "./output.ts";
import type {
  AppConfig,
  CommandDependencies,
  CommitAction,
  GitStatusSummary,
  OpenRouterRequest,
  ReasoningMode,
} from "./types.ts";

export async function runCli(
  argv: string[],
  dependencies: CommandDependencies = {},
): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd();
  const env = dependencies.env ?? process.env;
  const output = dependencies.output ?? createConsoleOutput();
  const prompt = dependencies.prompt ?? createConsolePrompt();
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const gitClient = dependencies.gitClient ?? defaultGitClient;
  const commitMessageGenerator = dependencies.generateCommitMessage ?? generateCommitMessage;

  try {
    const parsed = parseArgs(argv);
    if (parsed.name === "help") {
      output.info(helpText());
      return 0;
    }

    if (parsed.name === "gitignore") {
      await runGitignoreFlow({
        cwd,
        output,
        prompt,
        autoConfirm: Boolean(parsed.flags.yes),
      });
      return 0;
    }

    if (parsed.name === "status") {
      gitClient.ensureGitAvailable(cwd);
      renderStatus(output, gitClient.getStatusSummary(cwd));
      return 0;
    }

    gitClient.ensureGitAvailable(cwd);
    const config = loadConfig(cwd, env);

    switch (parsed.name) {
      case "commit": {
        const model = getStringFlag(parsed.flags.model, config.model);
        await runCommitFlow({
          cwd,
          config,
          model,
          reasoningMode: resolveReasoningMode(config.reasoningMode, parsed.flags),
          output,
          prompt,
          fetchImpl,
          gitClient,
          commitMessageGenerator,
          autoConfirm: Boolean(parsed.flags.yes),
          stageAll: Boolean(parsed.flags.all),
        });
        return 0;
      }
      case "branch-commit": {
        const branchName = parsed.positionals[0];
        if (!branchName) {
          throw new UserError("branch-commit requires a branch name.");
        }

        gitClient.switchToNewBranch(cwd, branchName);
        if (output.success) {
          output.success(`Switched to new branch: ${branchName}`);
        } else {
          output.info(`Switched to new branch: ${branchName}`);
        }

        const model = getStringFlag(parsed.flags.model, config.model);
        await runCommitFlow({
          cwd,
          config,
          model,
          reasoningMode: resolveReasoningMode(config.reasoningMode, parsed.flags),
          output,
          prompt,
          fetchImpl,
          gitClient,
          commitMessageGenerator,
          autoConfirm: Boolean(parsed.flags.yes),
          stageAll: Boolean(parsed.flags.all),
        });
        return 0;
      }
      case "guide": {
        await runGuideFlow({
          cwd,
          config,
          output,
          prompt,
          fetchImpl,
          gitClient,
          commitMessageGenerator,
        });
        return 0;
      }
      case "push": {
        renderCommandHeader(output, "AutoGit Push", [
          { label: "Branch", value: gitClient.getCurrentBranch(cwd) },
        ]);
        const branchName = gitClient.pushCurrentBranch(cwd);
        if (output.success) {
          output.success(`Pushed branch: ${branchName}`);
        } else {
          output.info(`Pushed branch: ${branchName}`);
        }
        return 0;
      }
      case "pr": {
        const base = getOptionalStringFlag(parsed.flags.base) ?? config.defaultBaseBranch;
        const title = getOptionalStringFlag(parsed.flags.title);
        const body = getOptionalStringFlag(parsed.flags.body);
        renderCommandHeader(output, "AutoGit PR", [
          { label: "Branch", value: gitClient.getCurrentBranch(cwd) },
          { label: "Base", value: base ?? "(gh default)" },
          { label: "Title", value: title ?? "(gh prompt)" },
        ]);
        gitClient.createPullRequest(cwd, { base, title, body });
        if (output.success) {
          output.success("Pull request created via gh.");
        } else {
          output.info("Pull request created via gh.");
        }
        return 0;
      }
      case "publish": {
        const visibility = resolvePublishVisibility(parsed.flags);
        const repoRoot = gitClient.resolveRepoRoot(cwd);
        const branchName = gitClient.getCurrentBranch(cwd);
        const repoName = parsed.positionals[0];
        const displayName = repoName ?? repoRoot.split(/[/\\]/).pop() ?? "repository";

        renderCommandHeader(output, "AutoGit Publish", [
          { label: "Repo", value: displayName },
          { label: "Branch", value: branchName },
          { label: "Visibility", value: visibility },
        ]);

        if (!parsed.flags.yes) {
          const confirmed = await prompt.confirm("Create the GitHub repository and push now?");
          if (!confirmed) {
            throw new UserError("Publish aborted.");
          }
        }

        const publishedName = gitClient.publishRepository(cwd, {
          name: repoName,
          visibility,
        });
        if (output.success) {
          output.success(`Published GitHub repository: ${publishedName}`);
        } else {
          output.info(`Published GitHub repository: ${publishedName}`);
        }
        return 0;
      }
      default:
        return 1;
    }
  } catch (error) {
    if (error instanceof UserError) {
      output.error(`Error: ${error.message}`);
      return 1;
    }

    output.error(`Unexpected error: ${(error as Error).message}`);
    return 1;
  }
}

async function runCommitFlow(options: {
  cwd: string;
  config: AppConfig;
  model: string;
  reasoningMode: ReasoningMode;
  output: CommandDependencies["output"];
  prompt: NonNullable<CommandDependencies["prompt"]>;
  fetchImpl: typeof fetch;
  gitClient: NonNullable<CommandDependencies["gitClient"]>;
  commitMessageGenerator: NonNullable<CommandDependencies["generateCommitMessage"]>;
  autoConfirm: boolean;
  stageAll: boolean;
}): Promise<{ pushed: boolean }> {
  let diff = options.gitClient.getStagedDiff(options.cwd);
  if (!diff.trim()) {
    const hasWorkingTreeChanges = options.gitClient.hasWorkingTreeChanges(options.cwd);

    if (!hasWorkingTreeChanges) {
      throw new UserError("No changes found. Modify files before running autogit commit.");
    }

    if (options.stageAll) {
      options.output?.info("Staging all changes.");
      options.gitClient.stageAllChanges(options.cwd);
    } else {
      const shouldStageAll = await options.prompt.confirm(
        "No staged changes found. Stage all tracked and untracked changes?",
      );

      if (!shouldStageAll) {
        throw new UserError(
          "Commit aborted. Stage files manually or rerun with --all.",
        );
      }

      options.output?.info("Staging all changes.");
      options.gitClient.stageAllChanges(options.cwd);
    }

    diff = options.gitClient.getStagedDiff(options.cwd);
    if (!diff.trim()) {
      throw new UserError("No staged changes found after staging all changes.");
    }
  }

  const repoRoot = options.gitClient.resolveRepoRoot(options.cwd);
  const branchName = options.gitClient.getCurrentBranch(options.cwd);
  const stagedFiles = options.gitClient.getStagedFiles(options.cwd);
  const config = requireApiKey(options.config);
  renderCommitHeader(options.output, {
    branchName,
    stagedFiles,
    model: options.model,
  });

  let message = "";
  let regenerateFeedback: string | undefined;

  while (true) {
    options.output?.startSpinner?.("Generating commit message");

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
      options.fetchImpl,
      options.commitMessageGenerator,
      options.output,
      {
        onToken(token) {
          if (!streamedAny) {
            options.output?.stopSpinner?.();
            options.output?.info("");
            if (options.output?.headline) {
              options.output.headline("Suggested commit message");
            } else {
              options.output?.info("Suggested commit message:");
            }
            options.output?.info("");
          }
          streamedAny = true;
          options.output?.stream?.(token);
        },
      },
    );

    options.output?.stopSpinner?.();

    if (streamedAny) {
      options.output?.endStream?.();
      options.output?.info("");
    } else {
      renderCommitMessage(options.output, message);
    }

    if (options.autoConfirm) {
      options.gitClient.commitWithMessage(options.cwd, message);
      if (options.output?.success) {
        options.output.success("Committed changes.");
      } else {
        options.output?.info("Committed changes.");
      }
      return { pushed: false };
    }

    renderCommitActions(options.output);
    const action = await chooseCommitAction(options.prompt);

    if (action === "regenerate") {
      regenerateFeedback = await requestRegenerateFeedback(options.prompt);
      continue;
    }

    if (action === "edit") {
      const edited = await editCommitMessage(options.prompt, message);
      if (!edited) {
        throw new UserError("Commit aborted.");
      }

      message = edited;
      renderCommitMessage(options.output, message);

      renderCommitActions(options.output);
      const followUpAction = await chooseCommitAction(options.prompt);
      if (followUpAction === "regenerate") {
        regenerateFeedback = await requestRegenerateFeedback(options.prompt);
        continue;
      }
      return applyCommitAction(followUpAction, options, message);
    }

    return applyCommitAction(action, options, message);
  }
}

async function runGuideFlow(options: {
  cwd: string;
  config: AppConfig;
  output: CommandDependencies["output"];
  prompt: NonNullable<CommandDependencies["prompt"]>;
  fetchImpl: typeof fetch;
  gitClient: NonNullable<CommandDependencies["gitClient"]>;
  commitMessageGenerator: NonNullable<CommandDependencies["generateCommitMessage"]>;
}): Promise<void> {
  const status = options.gitClient.getStatusSummary(options.cwd);
  renderStatus(options.output, status);

  if (status.clean) {
    if (options.output?.success) {
      options.output.success("Nothing to do. Working tree is clean.");
    } else {
      options.output?.info("Nothing to do. Working tree is clean.");
    }
    return;
  }

  const result = await runCommitFlow({
    cwd: options.cwd,
    config: options.config,
    model: options.config.model,
    reasoningMode: options.config.reasoningMode,
    output: options.output,
    prompt: options.prompt,
    fetchImpl: options.fetchImpl,
    gitClient: options.gitClient,
    commitMessageGenerator: options.commitMessageGenerator,
    autoConfirm: false,
    stageAll: false,
  });

  let pushed = result.pushed;
  const currentBranch = options.gitClient.getCurrentBranch(options.cwd);
  if (!pushed && (await options.prompt.confirm("Push the current branch now?"))) {
    const branchName = options.gitClient.pushCurrentBranch(options.cwd);
    pushed = true;
    if (options.output?.success) {
      options.output.success(`Pushed branch: ${branchName}`);
    } else {
      options.output?.info(`Pushed branch: ${branchName}`);
    }
  }

  if (
    pushed &&
    shouldOfferPullRequest(currentBranch, options.config.defaultBaseBranch) &&
    (await options.prompt.confirm("Create a pull request now?"))
  ) {
    renderCommandHeader(options.output, "AutoGit PR", [
      { label: "Branch", value: currentBranch },
      { label: "Base", value: options.config.defaultBaseBranch ?? "(gh default)" },
      { label: "Title", value: "(gh prompt)" },
    ]);
    options.gitClient.createPullRequest(options.cwd, {
      base: options.config.defaultBaseBranch,
    });
    if (options.output?.success) {
      options.output.success("Pull request created via gh.");
    } else {
      options.output?.info("Pull request created via gh.");
    }
  }
}

function getStringFlag(value: string | boolean | undefined, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function getOptionalStringFlag(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function resolveReasoningMode(
  configReasoningMode: ReasoningMode,
  flags: Record<string, string | boolean>,
): ReasoningMode {
  if (flags["no-reasoning"]) {
    return "off";
  }

  if (flags.reasoning) {
    return "on";
  }

  return configReasoningMode;
}

function resolvePublishVisibility(flags: Record<string, string | boolean>): "public" | "private" {
  if (flags.public && flags.private) {
    throw new UserError("Use only one of --public or --private.");
  }

  if (flags.public) {
    return "public";
  }

  return "private";
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

function renderCommitHeader(
  output: CommandDependencies["output"],
  context: {
    branchName: string;
    stagedFiles: string[];
    model: string;
  },
): void {
  if (output?.headline) {
    output.headline("AutoGit");
  } else {
    output?.info("AutoGit");
  }

  if (output?.keyValue) {
    output.keyValue("Branch", context.branchName);
    output.keyValue(
      "Staged",
      `${context.stagedFiles.length} file${context.stagedFiles.length === 1 ? "" : "s"}`,
    );
    output.keyValue("Model", context.model);
  } else {
    output?.info(`Branch: ${context.branchName}`);
    output?.info(
      `Staged: ${context.stagedFiles.length} file${context.stagedFiles.length === 1 ? "" : "s"}`,
    );
    output?.info(`Model: ${context.model}`);
  }
  output?.info("");
}

function renderCommandHeader(
  output: CommandDependencies["output"],
  title: string,
  items: Array<{ label: string; value: string }>,
): void {
  if (output?.headline) {
    output.headline(title);
  } else {
    output?.info(title);
  }

  if (output?.keyValue) {
    for (const item of items) {
      output.keyValue(item.label, item.value);
    }
  } else {
    for (const item of items) {
      output?.info(`${item.label}: ${item.value}`);
    }
  }

  output?.info("");
}

function renderStatus(output: CommandDependencies["output"], status: GitStatusSummary): void {
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

  if (output?.box) {
    output.box("Working tree", content);
  } else {
    output?.info(content);
  }

  output?.info("");

  if (status.clean) {
    if (output?.success) {
      output.success("Working tree is clean.");
    } else {
      output?.info("Working tree is clean.");
    }
  } else if (output?.warn) {
    output.warn("Pending changes detected.");
  } else {
    output?.info("Pending changes detected.");
  }
}

function renderCommitMessage(output: CommandDependencies["output"], message: string): void {
  if (output?.box) {
    output.box("Suggested commit message", message);
  } else {
    output?.info("Suggested commit message:");
    output?.info("");
    output?.info(message);
  }
  output?.info("");
}

async function chooseCommitAction(prompt: NonNullable<CommandDependencies["prompt"]>): Promise<CommitAction> {
  if (prompt.chooseCommitAction) {
    return prompt.chooseCommitAction("");
  }

  const confirmed = await prompt.confirm("Create commit with this message?");
  return confirmed ? "commit" : "cancel";
}

function renderCommitActions(output: CommandDependencies["output"]): void {
  if (output?.actionLine) {
    output.actionLine([
      { key: "Enter", label: "Commit" },
      { key: "p", label: "Commit & Push" },
      { key: "e", label: "Edit" },
      { key: "r", label: "Regenerate" },
      { key: "c", label: "Cancel" },
    ]);
  } else {
    output?.info("[Enter] commit  [p] commit & push  [e] edit  [r] regenerate  [c] cancel");
  }
}

async function editCommitMessage(
  prompt: NonNullable<CommandDependencies["prompt"]>,
  message: string,
): Promise<string | null> {
  if (!prompt.editMessage) {
    return message;
  }

  return prompt.editMessage(message);
}

async function requestRegenerateFeedback(
  prompt: NonNullable<CommandDependencies["prompt"]>,
): Promise<string | undefined> {
  if (!prompt.input) {
    return undefined;
  }

  const value = (await prompt.input("Feedback for regeneration (optional): ")).trim();
  return value || undefined;
}

async function applyCommitAction(
  action: CommitAction,
  options: {
    cwd: string;
    output: CommandDependencies["output"];
    gitClient: NonNullable<CommandDependencies["gitClient"]>;
  },
  message: string,
): Promise<{ pushed: boolean }> {
  switch (action) {
    case "commit":
      options.gitClient.commitWithMessage(options.cwd, message);
      if (options.output?.success) {
        options.output.success("Committed changes.");
      } else {
        options.output?.info("Committed changes.");
      }
      return { pushed: false };
    case "push": {
      options.gitClient.commitWithMessage(options.cwd, message);
      const branchName = options.gitClient.pushCurrentBranch(options.cwd);
      if (options.output?.success) {
        options.output.success(`Committed and pushed branch: ${branchName}`);
      } else {
        options.output?.info(`Committed and pushed branch: ${branchName}`);
      }
      return { pushed: true };
    }
    case "cancel":
      throw new UserError("Commit aborted.");
    case "edit":
    case "regenerate":
      throw new UserError(`Unsupported commit action: ${action}`);
  }
}

async function generateCommitMessageWithFallback(
  config: AppConfig & { apiKey: string },
  request: OpenRouterRequest,
  fetchImpl: typeof fetch,
  commitMessageGenerator: NonNullable<CommandDependencies["generateCommitMessage"]>,
  output: CommandDependencies["output"],
  generatorOptions?: {
    onToken?: (token: string) => void;
  },
): Promise<string> {
  try {
    return await commitMessageGenerator(config, request, fetchImpl, generatorOptions);
  } catch (error) {
    if (!(error instanceof UserError)) {
      throw error;
    }

    if (request.reasoningMode !== "off" || !isMandatoryReasoningError(error.message)) {
      throw error;
    }

    if (output?.warn) {
      output.warn(
        "Reasoning cannot be disabled for this model/provider. Retrying with provider-default reasoning.",
      );
    } else {
      output?.info(
        "Reasoning cannot be disabled for this model/provider. Retrying with provider-default reasoning.",
      );
    }

    return commitMessageGenerator(
      config,
      {
        ...request,
        reasoningMode: "auto",
      },
      fetchImpl,
      generatorOptions,
    );
  }
}

function isMandatoryReasoningError(message: string): boolean {
  return /reasoning is mandatory.*cannot be disabled/i.test(message);
}
