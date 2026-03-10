export type OutputWriter = {
  info(message: string): void;
  error(message: string): void;
  stream(chunk: string): void;
  endStream(): void;
  startSpinner(message: string): void;
  stopSpinner(): void;
  headline(message: string): void;
  keyValue(label: string, value: string): void;
  box(title: string, content: string): void;
  actionLine(items: Array<{ key: string; label: string }>): void;
  success(message: string): void;
  warn(message: string): void;
};

export type CommitAction = "commit" | "push" | "branch" | "edit" | "regenerate" | "cancel";

export type PromptHandler = {
  confirm(message: string): Promise<boolean>;
  chooseCommitAction?(message: string): Promise<CommitAction>;
  editMessage?(message: string): Promise<string | null>;
  input?(message: string): Promise<string>;
};

export type CommandDependencies = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  output?: OutputWriter;
  prompt?: PromptHandler;
  fetchImpl?: typeof fetch;
  gitClient?: GitClient;
  generateCommitMessage?: CommitMessageGenerator;
};

export type CliContext = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  output: OutputWriter;
  prompt: PromptHandler;
  fetchImpl: typeof fetch;
  git: GitClient;
  generateCommitMessage: CommitMessageGenerator;
};

export type ParsedCommand = {
  name: "commit" | "push" | "pr" | "branch-commit" | "gitignore" | "publish" | "status" | "guide" | "help";
  flags: Record<string, string | boolean>;
  positionals: string[];
};

export type ReasoningMode = "auto" | "on" | "off";

export type AppConfig = {
  apiKey?: string;
  model: string;
  baseUrl: string;
  systemPrompt: string;
  defaultBaseBranch?: string;
  reasoningMode: ReasoningMode;
};

export type OpenRouterRequest = {
  model: string;
  systemPrompt: string;
  diff: string;
  repoRoot: string;
  reasoningMode: ReasoningMode;
  regenerateFeedback?: string;
};

export type GitStatusSummary = {
  branchName: string;
  upstream?: string;
  ahead: number;
  behind: number;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  clean: boolean;
};

export type GitClient = {
  ensureGitAvailable(cwd: string): void;
  resolveRepoRoot(cwd: string): string;
  getCurrentBranch(cwd: string): string;
  getStagedFiles(cwd: string): string[];
  getStatusSummary(cwd: string): GitStatusSummary;
  getStagedDiff(cwd: string): string;
  hasWorkingTreeChanges(cwd: string): boolean;
  stageAllChanges(cwd: string): void;
  commitWithMessage(cwd: string, message: string): void;
  switchToNewBranch(cwd: string, branchName: string): void;
  pushCurrentBranch(cwd: string): string;
  createPullRequest(
    cwd: string,
    options: {
      base?: string;
      title?: string;
      body?: string;
    },
  ): void;
  publishRepository(
    cwd: string,
    options: {
      name?: string;
      visibility: "public" | "private";
    },
  ): string;
};

export type CommitMessageGenerator = (
  config: AppConfig & { apiKey: string },
  request: OpenRouterRequest,
  fetchImpl: typeof fetch,
  options?: {
    onToken?: (token: string) => void;
  },
) => Promise<string>;
