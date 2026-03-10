import { helpText, parseArgs } from "./args.ts";
import { runCommitFlow } from "./commands/commit.ts";
import { loadConfig } from "./config.ts";
import { UserError } from "./errors.ts";
import { gitClient as defaultGitClient } from "./git.ts";
import { runGitignoreFlow } from "./gitignore.ts";
import { generateCommitMessage } from "./openrouter.ts";
import { createConsoleOutput, createConsolePrompt, emitSuccess } from "./output.ts";
import { renderCommandHeader, renderStatus } from "./render.ts";
import type { CliContext, CommandDependencies, ReasoningMode } from "./types.ts";

export async function runCli(
  argv: string[],
  dependencies: CommandDependencies = {},
): Promise<number> {
  const ctx: CliContext = {
    cwd: dependencies.cwd ?? process.cwd(),
    env: dependencies.env ?? process.env,
    output: dependencies.output ?? createConsoleOutput(),
    prompt: dependencies.prompt ?? createConsolePrompt(),
    fetchImpl: dependencies.fetchImpl ?? fetch,
    git: dependencies.gitClient ?? defaultGitClient,
    generateCommitMessage: dependencies.generateCommitMessage ?? generateCommitMessage,
  };

  try {
    const parsed = parseArgs(argv);

    if (parsed.name === "help") {
      ctx.output.info(helpText());
      return 0;
    }

    if (parsed.name === "gitignore") {
      await runGitignoreFlow({
        cwd: ctx.cwd,
        output: ctx.output,
        prompt: ctx.prompt,
        autoConfirm: Boolean(parsed.flags.yes),
      });
      return 0;
    }

    if (parsed.name === "status") {
      ctx.git.ensureGitAvailable(ctx.cwd);
      renderStatus(ctx.output, ctx.git.getStatusSummary(ctx.cwd));
      return 0;
    }

    ctx.git.ensureGitAvailable(ctx.cwd);
    const config = loadConfig(ctx.cwd, ctx.env);

    switch (parsed.name) {
      case "commit": {
        const model = getStringFlag(parsed.flags.model, config.model);
        await runCommitFlow(ctx, {
          config,
          model,
          reasoningMode: resolveReasoningMode(config.reasoningMode, parsed.flags),
          autoConfirm: Boolean(parsed.flags.yes),
          stageAll: Boolean(parsed.flags.all),
        });
        return 0;
      }
      case "push": {
        renderCommandHeader(ctx.output, "AutoGit Push", [
          { label: "Branch", value: ctx.git.getCurrentBranch(ctx.cwd) },
        ]);
        const branchName = ctx.git.pushCurrentBranch(ctx.cwd);
        emitSuccess(ctx.output, `Pushed branch: ${branchName}`);
        return 0;
      }
      case "pr": {
        const base = getOptionalStringFlag(parsed.flags.base) ?? config.defaultBaseBranch;
        const title = getOptionalStringFlag(parsed.flags.title);
        const body = getOptionalStringFlag(parsed.flags.body);
        renderCommandHeader(ctx.output, "AutoGit PR", [
          { label: "Branch", value: ctx.git.getCurrentBranch(ctx.cwd) },
          { label: "Base", value: base ?? "(gh default)" },
          { label: "Title", value: title ?? "(gh prompt)" },
        ]);
        ctx.git.createPullRequest(ctx.cwd, { base, title, body });
        emitSuccess(ctx.output, "Pull request created via gh.");
        return 0;
      }
      case "publish": {
        const visibility = resolvePublishVisibility(parsed.flags);
        const repoRoot = ctx.git.resolveRepoRoot(ctx.cwd);
        const branchName = ctx.git.getCurrentBranch(ctx.cwd);
        const repoName = parsed.positionals[0];
        const displayName = repoName ?? repoRoot.split(/[/\\]/).pop() ?? "repository";

        renderCommandHeader(ctx.output, "AutoGit Publish", [
          { label: "Repo", value: displayName },
          { label: "Branch", value: branchName },
          { label: "Visibility", value: visibility },
        ]);

        if (!parsed.flags.yes) {
          const confirmed = await ctx.prompt.confirm("Create the GitHub repository and push now?");
          if (!confirmed) {
            throw new UserError("Publish aborted.");
          }
        }

        const publishedName = ctx.git.publishRepository(ctx.cwd, {
          name: repoName,
          visibility,
        });
        emitSuccess(ctx.output, `Published GitHub repository: ${publishedName}`);
        return 0;
      }
      default:
        return 1;
    }
  } catch (error) {
    if (error instanceof UserError) {
      ctx.output.error(`Error: ${error.message}`);
      return 1;
    }

    ctx.output.error(`Unexpected error: ${(error as Error).message}`);
    return 1;
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
  if (flags["no-reasoning"]) return "off";
  if (flags.reasoning) return "on";
  return configReasoningMode;
}

function resolvePublishVisibility(flags: Record<string, string | boolean>): "public" | "private" {
  if (flags.public && flags.private) {
    throw new UserError("Use only one of --public or --private.");
  }
  return flags.public ? "public" : "private";
}
