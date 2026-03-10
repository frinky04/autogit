import { UserError } from "./errors.ts";
import type { AppConfig, OpenRouterRequest } from "./types.ts";

export async function generateCommitMessage(
  config: AppConfig,
  request: OpenRouterRequest,
  fetchImpl: typeof fetch,
  options: {
    onToken?: (token: string) => void;
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
    return parseStreamingCommitMessage(response, options.onToken);
  }

  return parseJsonCommitMessage(response);
}

async function parseJsonCommitMessage(response: Response): Promise<string> {
  const json = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | Array<{ type?: string; text?: string }>;
      };
    }>;
  };

  const content = json.choices?.[0]?.message?.content;
  const text = flattenMessageContent(content);
  const sanitized = sanitizeCommitMessage(text);

  if (!sanitized) {
    throw new UserError("OpenRouter returned an empty commit message.");
  }

  return sanitized;
}

async function parseStreamingCommitMessage(
  response: Response,
  onToken?: (token: string) => void,
): Promise<string> {
  if (!response.body) {
    throw new UserError("OpenRouter returned an empty streaming response body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let combined = "";

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

      const token = parseSseEvent(rawEvent);
      if (token) {
        combined += token;
        onToken?.(token);
      }

      boundaryIndex = buffer.indexOf("\n\n");
    }
  }

  buffer += decoder.decode();
  const trailingToken = parseSseEvent(buffer);
  if (trailingToken) {
    combined += trailingToken;
    onToken?.(trailingToken);
  }

  const sanitized = sanitizeCommitMessage(combined);
  if (!sanitized) {
    throw new UserError("OpenRouter returned an empty commit message.");
  }

  return sanitized;
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

function flattenMessageContent(
  content: string | Array<{ type?: string; text?: string }> | undefined,
): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === "text" || !part.type ? part.text ?? "" : ""))
      .join("")
      .trim();
  }

  return "";
}

function flattenDeltaContent(
  content:
    | string
    | Array<{ type?: string; text?: string }>
    | Array<{ type?: string; content?: string; text?: string }>
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

function parseSseEvent(rawEvent: string): string {
  const trimmed = rawEvent.trim();
  if (!trimmed) {
    return "";
  }

  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(":"))
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());

  if (dataLines.length === 0) {
    return "";
  }

  const payload = dataLines.join("\n");
  if (payload === "[DONE]") {
    return "";
  }

  let parsed: {
    error?: { message?: string };
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
    return "";
  }

  if (parsed.error?.message) {
    throw new UserError(parsed.error.message);
  }

  const choice = parsed.choices?.[0];
  return flattenDeltaContent(choice?.delta?.content) || flattenMessageContent(choice?.message?.content);
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
