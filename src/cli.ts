import { helpText, parseArgs } from "./args.ts";
import { loadConfig, requireApiKey } from "./config.ts";
import { UserError } from "./errors.ts";
import { gitClient as defaultGitClient } from "./git.ts";
import { runGitignoreFlow } from "./gitignore.ts";
import { generateCommitMessage } from "./openrouter.ts";
import { createConsoleOutput, createConsolePrompt } from "./output.ts";
import type { AppConfig, CommandDependencies, CommitAction, OpenRouterRequest, ReasoningMode } from "./types.ts";

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
        output.success?.(`Switched to new branch: ${branchName}`) ?? output.info(`Switched to new branch: ${branchName}`);

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
      case "push": {
        const branchName = gitClient.pushCurrentBranch(cwd);
        output.success?.(`Pushed branch: ${branchName}`) ?? output.info(`Pushed branch: ${branchName}`);
        return 0;
      }
      case "pr": {
        const base = getOptionalStringFlag(parsed.flags.base) ?? config.defaultBaseBranch;
        const title = getOptionalStringFlag(parsed.flags.title);
        const body = getOptionalStringFlag(parsed.flags.body);
        gitClient.createPullRequest(cwd, { base, title, body });
        output.success?.("Pull request created via gh.") ?? output.info("Pull request created via gh.");
        return 0;
      }
      case "publish": {
        const visibility = resolvePublishVisibility(parsed.flags);
        const repoRoot = gitClient.resolveRepoRoot(cwd);
        const branchName = gitClient.getCurrentBranch(cwd);
        const repoName = parsed.positionals[0];
        const displayName = repoName ?? repoRoot.split(/[/\\]/).pop() ?? "repository";

        output.info(
          `Preparing to publish ${displayName} as a ${visibility} GitHub repository from branch ${branchName}.`,
        );

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
        output.success?.(`Published GitHub repository: ${publishedName}`) ??
          output.info(`Published GitHub repository: ${publishedName}`);
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
}): Promise<void> {
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

  while (true) {
    options.output?.startSpinner?.("Generating commit message");

    const request: OpenRouterRequest = {
      model: options.model,
      systemPrompt: config.systemPrompt,
      diff,
      repoRoot,
      reasoningMode: options.reasoningMode,
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
            options.output?.headline?.("Suggested commit message") ??
              options.output?.info("Suggested commit message:");
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
      options.output?.info("Committed changes.");
      return;
    }

    renderCommitActions(options.output);
    const action = await chooseCommitAction(options.prompt);

    if (action === "regenerate") {
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
      await applyCommitAction(followUpAction, options, message);
      return;
    }

    await applyCommitAction(action, options, message);
    return;
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

function renderCommitHeader(
  output: CommandDependencies["output"],
  context: {
    branchName: string;
    stagedFiles: string[];
    model: string;
  },
): void {
  output?.headline?.("AutoGit") ?? output?.info("AutoGit");
  output?.keyValue?.("Branch", context.branchName) ?? output?.info(`Branch: ${context.branchName}`);
  output?.keyValue?.(
    "Staged",
    `${context.stagedFiles.length} file${context.stagedFiles.length === 1 ? "" : "s"}`,
  ) ?? output?.info(
    `Staged: ${context.stagedFiles.length} file${context.stagedFiles.length === 1 ? "" : "s"}`,
  );
  output?.keyValue?.("Model", context.model) ?? output?.info(`Model: ${context.model}`);
  output?.info("");
}

function renderCommitMessage(output: CommandDependencies["output"], message: string): void {
  output?.box?.("Suggested commit message", message) ??
    (output?.info("Suggested commit message:"), output?.info(""), output?.info(message), output?.info(""));
  output?.info("");
}

async function chooseCommitAction(prompt: NonNullable<CommandDependencies["prompt"]>): Promise<CommitAction> {
  if (prompt.chooseCommitAction) {
    return prompt.chooseCommitAction("[Enter] commit  [p] commit & push  [e] edit  [r] regenerate  [c] cancel");
  }

  const confirmed = await prompt.confirm("Create commit with this message?");
  return confirmed ? "commit" : "cancel";
}

function renderCommitActions(output: CommandDependencies["output"]): void {
  output?.actionLine?.([
    { key: "Enter", label: "Commit" },
    { key: "p", label: "Commit & Push" },
    { key: "e", label: "Edit" },
    { key: "r", label: "Regenerate" },
    { key: "c", label: "Cancel" },
  ]) ?? output?.info("[Enter] commit  [p] commit & push  [e] edit  [r] regenerate  [c] cancel");
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

async function applyCommitAction(
  action: CommitAction,
  options: {
    cwd: string;
    output: CommandDependencies["output"];
    gitClient: NonNullable<CommandDependencies["gitClient"]>;
  },
  message: string,
): Promise<void> {
  switch (action) {
    case "commit":
      options.gitClient.commitWithMessage(options.cwd, message);
      options.output?.success?.("Committed changes.") ?? options.output?.info("Committed changes.");
      return;
    case "push": {
      options.gitClient.commitWithMessage(options.cwd, message);
      const branchName = options.gitClient.pushCurrentBranch(options.cwd);
      options.output?.success?.(`Committed and pushed branch: ${branchName}`) ??
        options.output?.info(`Committed and pushed branch: ${branchName}`);
      return;
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

    output?.warn?.(
      "Reasoning cannot be disabled for this model/provider. Retrying with provider-default reasoning.",
    ) ?? output?.info(
      "Reasoning cannot be disabled for this model/provider. Retrying with provider-default reasoning.",
    );

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
