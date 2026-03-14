import { UserError } from "./errors.ts";
import type {
  AppConfig,
  CommitMessageGenerator,
  OpenRouterRequest,
  OutputWriter,
  PullRequestDraft,
  PullRequestDraftGenerator,
  PullRequestDraftRequest,
  TokenUsage,
} from "./types.ts";
import { emitWarn } from "./output.ts";

export async function generateCommitMessage(
  config: AppConfig,
  request: OpenRouterRequest,
  fetchImpl: typeof fetch,
  options: {
    onToken?: (token: string) => void;
    onUsage?: (usage: TokenUsage) => void;
  } = {},
): Promise<string> {
  const body = {
    model: request.model,
    messages: [
      {
        role: "system",
        content: request.systemPrompt,
      },
      {
        role: "user",
        content: buildUserPrompt(request.diff, request.repoRoot, request.regenerateFeedback),
      },
    ],
    temperature: 0.2,
    stream: true,
    stream_options: { include_usage: true },
    ...(buildReasoningBody(request.reasoningMode) ?? {}),
  };

  const response = await fetchImpl(`${trimTrailingSlash(config.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/",
      "X-Title": "autogit",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new UserError(`OpenRouter request failed (${response.status}): ${body}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const result = await parseStreamingResponseText(
      response,
      "OpenRouter returned an empty commit message.",
      options.onToken,
    );
    if (result.usage) {
      options.onUsage?.(result.usage);
    }
    return result.text;
  }

  const result = await parseJsonResponseText(
    response,
    "OpenRouter returned an empty commit message.",
  );
  if (result.usage) {
    options.onUsage?.(result.usage);
  }
  return result.text;
}

export async function generatePullRequestDraft(
  config: AppConfig,
  request: PullRequestDraftRequest,
  fetchImpl: typeof fetch,
  options: {
    onUsage?: (usage: TokenUsage) => void;
  } = {},
): Promise<PullRequestDraft> {
  const body = {
    model: request.model,
    messages: [
      {
        role: "system",
        content: request.systemPrompt,
      },
      {
        role: "user",
        content: buildPullRequestUserPrompt(request),
      },
    ],
    temperature: 0.2,
    stream: false,
    ...(buildReasoningBody(request.reasoningMode) ?? {}),
  };

  const response = await fetchImpl(`${trimTrailingSlash(config.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/",
      "X-Title": "autogit",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new UserError(`OpenRouter request failed (${response.status}): ${responseBody}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const result = contentType.includes("text/event-stream")
    ? await parseStreamingResponseText(response, "OpenRouter returned an empty PR draft.")
    : await parseJsonResponseText(response, "OpenRouter returned an empty PR draft.");
  if (result.usage) {
    options.onUsage?.(result.usage);
  }

  return parsePullRequestDraft(result.text);
}

async function parseJsonResponseText(
  response: Response,
  emptyErrorMessage: string,
): Promise<{ text: string; usage?: TokenUsage }> {
  const json = (await response.json()) as {
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      cost?: number | string;
    };
    choices?: Array<{
      message?: {
        content?: string | Array<{ type?: string; text?: string }>;
      };
    }>;
  };

  const content = json.choices?.[0]?.message?.content;
  const text = flattenContent(content);
  const sanitized = sanitizeCommitMessage(text);

  if (!sanitized) {
    throw new UserError(emptyErrorMessage);
  }

  return {
    text: sanitized,
    usage: normalizeTokenUsage(json.usage),
  };
}

async function parseStreamingResponseText(
  response: Response,
  emptyErrorMessage: string,
  onToken?: (token: string) => void,
): Promise<{ text: string; usage?: TokenUsage }> {
  if (!response.body) {
    throw new UserError("OpenRouter returned an empty streaming response body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let combined = "";
  let usage: TokenUsage | undefined;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let boundaryIndex = buffer.indexOf("\n\n");
    while (boundaryIndex >= 0) {
      const rawEvent = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);

      const event = parseSseEvent(rawEvent);
      if (event.usage) {
        usage = event.usage;
      }
      if (event.token) {
        combined += event.token;
        onToken?.(event.token);
      }

      boundaryIndex = buffer.indexOf("\n\n");
    }
  }

  buffer += decoder.decode();
  const trailingEvent = parseSseEvent(buffer);
  if (trailingEvent.usage) {
    usage = trailingEvent.usage;
  }
  if (trailingEvent.token) {
    combined += trailingEvent.token;
    onToken?.(trailingEvent.token);
  }

  const sanitized = sanitizeCommitMessage(combined);
  if (!sanitized) {
    throw new UserError(emptyErrorMessage);
  }

  return {
    text: sanitized,
    usage,
  };
}

export function sanitizeCommitMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return "";
  }

  let cleaned = trimmed.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "");
  cleaned = cleaned.replace(/\r\n/g, "\n").trim();

  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    try {
      cleaned = JSON.parse(cleaned);
    } catch {
      cleaned = cleaned.slice(1, -1).trim();
    }
  }

  const lines = cleaned
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, array) => !(line === "" && array[index - 1] === ""));

  return lines.join("\n").trim();
}

function buildUserPrompt(
  diff: string,
  repoRoot: string,
  regenerateFeedback?: string,
): string {
  const feedbackBlock = regenerateFeedback
    ? `\nAdditional guidance for this regeneration:\n- ${regenerateFeedback}\n`
    : "";

  return `Repository root: ${repoRoot}

Write a git commit message for this staged diff.
Rules:
- Prefer Conventional Commit style when it fits.
- Keep the subject line concise and imperative.
- Include a body only if it adds useful context.
- Return only the commit message.
${feedbackBlock}

Staged diff:
${diff}`;
}

function buildPullRequestUserPrompt(request: PullRequestDraftRequest): string {
  const feedbackBlock = request.regenerateFeedback
    ? `\nAdditional guidance for this regeneration:\n- ${request.regenerateFeedback}\n`
    : "";

  const commitLogBlock = request.commitLog.trim()
    ? request.commitLog
    : "(No commit subjects found; use diff to infer changes.)";

  return `Repository root: ${request.repoRoot}
Head branch: ${request.branchName}
Base branch: ${request.baseBranch}

Generate a GitHub pull request draft from the branch diff.
Return ONLY JSON with this shape:
{
  "title": "string",
  "body": "markdown string"
}

Rules:
- Title should be concise and specific.
- Body should include: Summary, Key Changes, Testing.
- Mention notable risk or follow-up items when relevant.
- Do not wrap JSON in code fences.
${feedbackBlock}

Commit subjects between base and head:
${commitLogBlock}

Diff:
${request.diff}`;
}

function parsePullRequestDraft(content: string): PullRequestDraft {
  const normalized = sanitizeCommitMessage(content);
  const direct = tryParseJsonObject(normalized);
  if (direct) {
    return direct;
  }

  const fencedMatch = normalized.match(/\{[\s\S]*\}/);
  if (fencedMatch) {
    const extracted = tryParseJsonObject(fencedMatch[0]);
    if (extracted) {
      return extracted;
    }
  }

  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const titleIndex = lines.findIndex((line) => line.trim().length > 0);
  const title = titleIndex >= 0 ? lines[titleIndex].trim() : "";
  const body = lines.slice(titleIndex >= 0 ? titleIndex + 1 : 1).join("\n").trim();

  if (!title) {
    throw new UserError("OpenRouter returned an invalid PR draft (missing title).");
  }

  return {
    title,
    body: body || "No additional description provided.",
  };
}

function tryParseJsonObject(value: string): PullRequestDraft | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const body = typeof record.body === "string" ? record.body.trim() : "";

  if (!title) {
    return null;
  }

  return {
    title,
    body: body || "No additional description provided.",
  };
}

function flattenContent(
  content:
    | string
    | Array<{ type?: string; text?: string; content?: string }>
    | undefined,
): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => part.text ?? part.content ?? "")
      .join("");
  }

  return "";
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseSseEvent(rawEvent: string): { token: string; usage?: TokenUsage } {
  const trimmed = rawEvent.trim();
  if (!trimmed) {
    return { token: "" };
  }

  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(":"))
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());

  if (dataLines.length === 0) {
    return { token: "" };
  }

  const payload = dataLines.join("\n");
  if (payload === "[DONE]") {
    return { token: "" };
  }

  let parsed: {
    error?: { message?: string };
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      cost?: number | string;
    };
    choices?: Array<{
      delta?: {
        content?:
          | string
          | Array<{ type?: string; text?: string }>
          | Array<{ type?: string; content?: string; text?: string }>;
      };
      message?: {
        content?: string | Array<{ type?: string; text?: string }>;
      };
    }>;
  };

  try {
    parsed = JSON.parse(payload);
  } catch {
    return { token: "" };
  }

  if (parsed.error?.message) {
    throw new UserError(parsed.error.message);
  }

  const choice = parsed.choices?.[0];
  return {
    token: flattenContent(choice?.delta?.content) || flattenContent(choice?.message?.content),
    usage: normalizeTokenUsage(parsed.usage),
  };
}

function buildReasoningBody(mode: OpenRouterRequest["reasoningMode"]):
  | { reasoning: { enabled: true } | { effort: "none" } }
  | undefined {
  if (mode === "on") {
    return { reasoning: { enabled: true } };
  }

  if (mode === "off") {
    return { reasoning: { effort: "none" } };
  }

  return undefined;
}

export async function generateCommitMessageWithFallback(
  config: AppConfig & { apiKey: string },
  request: OpenRouterRequest,
  fetchImpl: typeof fetch,
  generator: CommitMessageGenerator,
  output: OutputWriter,
  options?: { onToken?: (token: string) => void; onUsage?: (usage: TokenUsage) => void },
): Promise<string> {
  try {
    return await generator(config, request, fetchImpl, options);
  } catch (error) {
    if (!(error instanceof UserError)) {
      throw error;
    }

    if (request.reasoningMode !== "off" || !isMandatoryReasoningError(error.message)) {
      throw error;
    }

    emitWarn(
      output,
      "Reasoning cannot be disabled for this model/provider. Retrying with provider-default reasoning.",
    );

    return generator(
      config,
      { ...request, reasoningMode: "auto" },
      fetchImpl,
      options,
    );
  }
}

export async function generatePullRequestDraftWithFallback(
  config: AppConfig & { apiKey: string },
  request: PullRequestDraftRequest,
  fetchImpl: typeof fetch,
  generator: PullRequestDraftGenerator,
  output: OutputWriter,
  options?: { onUsage?: (usage: TokenUsage) => void },
): Promise<PullRequestDraft> {
  try {
    return await generator(config, request, fetchImpl, options);
  } catch (error) {
    if (!(error instanceof UserError)) {
      throw error;
    }

    if (request.reasoningMode !== "off" || !isMandatoryReasoningError(error.message)) {
      throw error;
    }

    emitWarn(
      output,
      "Reasoning cannot be disabled for this model/provider. Retrying with provider-default reasoning.",
    );

    return generator(
      config,
      { ...request, reasoningMode: "auto" },
      fetchImpl,
      options,
    );
  }
}

function isMandatoryReasoningError(message: string): boolean {
  return /reasoning is mandatory.*cannot be disabled/i.test(message);
}

function normalizeTokenUsage(
  value:
    | {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      cost?: number | string;
    }
    | undefined,
): TokenUsage | undefined {
  if (!value) {
    return undefined;
  }

  const promptTokens = Number(value.prompt_tokens);
  const completionTokens = Number(value.completion_tokens);
  const totalTokens = Number(value.total_tokens);
  const parsedCost = value.cost === undefined ? undefined : Number(value.cost);

  if (
    !Number.isFinite(promptTokens) ||
    !Number.isFinite(completionTokens) ||
    !Number.isFinite(totalTokens)
  ) {
    return undefined;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    costCredits:
      parsedCost !== undefined && Number.isFinite(parsedCost) && parsedCost >= 0
        ? parsedCost
        : undefined,
  };
}
