import test from "node:test";
import assert from "node:assert/strict";

import { generateCommitMessage, generatePullRequestDraft, sanitizeCommitMessage } from "../src/openrouter.ts";

test("sanitizeCommitMessage removes code fences", () => {
  const message = sanitizeCommitMessage("```text\nfeat: add cli\n```");
  assert.equal(message, "feat: add cli");
});

test("sanitizeCommitMessage preserves subject and body", () => {
  const message = sanitizeCommitMessage(' "fix: trim output\\n\\nRemove duplicate blank lines" ');
  assert.equal(message, "fix: trim output\n\nRemove duplicate blank lines");
});

test("generateCommitMessage omits reasoning in auto mode", async () => {
  let body: Record<string, unknown> | undefined;
  let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;

  const fetchImpl: typeof fetch = async (_, init) => {
    body = JSON.parse(String(init?.body));

    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "feat: disable reasoning" } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
          cost: 0.000052,
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  const message = await generateCommitMessage(
    {
      apiKey: "test-key",
      model: "minimax/minimax-m2.5",
      baseUrl: "https://openrouter.ai/api/v1",
      systemPrompt: "test prompt",
      reasoningMode: "auto",
    },
    {
      model: "minimax/minimax-m2.5",
      systemPrompt: "test prompt",
      diff: "diff --git a/file b/file",
      repoRoot: "/repo",
      reasoningMode: "auto",
    },
    fetchImpl,
    {
      onUsage(value) {
        usage = value;
      },
    },
  );

  assert.equal(message, "feat: disable reasoning");
  assert.equal(body?.stream, true);
  assert.equal(body?.reasoning, undefined);
  assert.deepEqual(usage, {
    promptTokens: 10,
    completionTokens: 4,
    totalTokens: 14,
    costCredits: 0.000052,
  });
});

test("generateCommitMessage enables reasoning when requested", async () => {
  let body: Record<string, unknown> | undefined;

  const fetchImpl: typeof fetch = async (_, init) => {
    body = JSON.parse(String(init?.body));

    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "feat: enable reasoning" } }],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  const message = await generateCommitMessage(
    {
      apiKey: "test-key",
      model: "minimax/minimax-m2.5",
      baseUrl: "https://openrouter.ai/api/v1",
      systemPrompt: "test prompt",
      reasoningMode: "on",
    },
    {
      model: "minimax/minimax-m2.5",
      systemPrompt: "test prompt",
      diff: "diff --git a/file b/file",
      repoRoot: "/repo",
      reasoningMode: "on",
    },
    fetchImpl,
  );

  assert.equal(message, "feat: enable reasoning");
  assert.equal(body?.stream, true);
  assert.deepEqual(body?.reasoning, { enabled: true });
});

test("generateCommitMessage disables reasoning when requested", async () => {
  let body: Record<string, unknown> | undefined;

  const fetchImpl: typeof fetch = async (_, init) => {
    body = JSON.parse(String(init?.body));

    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "feat: disable reasoning explicitly" } }],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  const message = await generateCommitMessage(
    {
      apiKey: "test-key",
      model: "minimax/minimax-m2.5",
      baseUrl: "https://openrouter.ai/api/v1",
      systemPrompt: "test prompt",
      reasoningMode: "off",
    },
    {
      model: "minimax/minimax-m2.5",
      systemPrompt: "test prompt",
      diff: "diff --git a/file b/file",
      repoRoot: "/repo",
      reasoningMode: "off",
    },
    fetchImpl,
  );

  assert.equal(message, "feat: disable reasoning explicitly");
  assert.equal(body?.stream, true);
  assert.deepEqual(body?.reasoning, { effort: "none" });
});

test("generateCommitMessage streams token chunks from SSE", async () => {
  const streamed: string[] = [];
  let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          [
            ": OPENROUTER PROCESSING\n\n",
            'data: {"choices":[{"delta":{"content":"feat: "}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"add streaming"}}]}\n\n',
            'data: {"usage":{"prompt_tokens":42,"completion_tokens":5,"total_tokens":47,"cost":"0.000071"}}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
        ),
      );
      controller.close();
    },
  });

  const fetchImpl: typeof fetch = async () =>
    new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

  const message = await generateCommitMessage(
    {
      apiKey: "test-key",
      model: "qwen/qwen3-235b-a22b-2507",
      baseUrl: "https://openrouter.ai/api/v1",
      systemPrompt: "test prompt",
      reasoningMode: "auto",
    },
    {
      model: "qwen/qwen3-235b-a22b-2507",
      systemPrompt: "test prompt",
      diff: "diff --git a/file b/file",
      repoRoot: "/repo",
      reasoningMode: "auto",
    },
    fetchImpl,
    {
      onToken(token) {
        streamed.push(token);
      },
      onUsage(value) {
        usage = value;
      },
    },
  );

  assert.equal(message, "feat: add streaming");
  assert.deepEqual(streamed, ["feat: ", "add streaming"]);
  assert.deepEqual(usage, {
    promptTokens: 42,
    completionTokens: 5,
    totalTokens: 47,
    costCredits: 0.000071,
  });
});

test("generateCommitMessage includes regenerate feedback in the prompt", async () => {
  let body: Record<string, unknown> | undefined;

  const fetchImpl: typeof fetch = async (_, init) => {
    body = JSON.parse(String(init?.body));

    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "feat: revised message" } }],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  await generateCommitMessage(
    {
      apiKey: "test-key",
      model: "qwen/qwen3-235b-a22b-2507",
      baseUrl: "https://openrouter.ai/api/v1",
      systemPrompt: "test prompt",
      reasoningMode: "auto",
    },
    {
      model: "qwen/qwen3-235b-a22b-2507",
      systemPrompt: "test prompt",
      diff: "diff --git a/file b/file",
      repoRoot: "/repo",
      reasoningMode: "auto",
      regenerateFeedback: "make it shorter",
    },
    fetchImpl,
  );

  const messages = body?.messages as Array<{ role: string; content: string }>;
  assert.ok(messages[1].content.includes("make it shorter"));
});

test("generatePullRequestDraft parses JSON title and body", async () => {
  let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;

  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"title":"feat: add PR flow","body":"## Summary\\n- add flow"}' } }],
        usage: {
          prompt_tokens: 55,
          completion_tokens: 21,
          total_tokens: 76,
          cost: 0.000411,
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );

  const draft = await generatePullRequestDraft(
    {
      apiKey: "test-key",
      model: "qwen/qwen3-235b-a22b-2507",
      baseUrl: "https://openrouter.ai/api/v1",
      systemPrompt: "commit prompt",
      reasoningMode: "auto",
    },
    {
      model: "qwen/qwen3-235b-a22b-2507",
      systemPrompt: "pr prompt",
      diff: "diff --git a/file b/file",
      repoRoot: "/repo",
      branchName: "feature/new-pr-flow",
      baseBranch: "main",
      commitLog: "abc123 feat: improve flow",
      reasoningMode: "auto",
    },
    fetchImpl,
    {
      onUsage(value) {
        usage = value;
      },
    },
  );

  assert.deepEqual(draft, {
    title: "feat: add PR flow",
    body: "## Summary\n- add flow",
  });
  assert.deepEqual(usage, {
    promptTokens: 55,
    completionTokens: 21,
    totalTokens: 76,
    costCredits: 0.000411,
  });
});

test("generatePullRequestDraft includes regeneration feedback in prompt", async () => {
  let body: Record<string, unknown> | undefined;

  const fetchImpl: typeof fetch = async (_, init) => {
    body = JSON.parse(String(init?.body));

    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"title":"feat: regenerate","body":"## Summary\\n- updated"}' } }],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  await generatePullRequestDraft(
    {
      apiKey: "test-key",
      model: "qwen/qwen3-235b-a22b-2507",
      baseUrl: "https://openrouter.ai/api/v1",
      systemPrompt: "commit prompt",
      reasoningMode: "auto",
    },
    {
      model: "qwen/qwen3-235b-a22b-2507",
      systemPrompt: "pr prompt",
      diff: "diff --git a/file b/file",
      repoRoot: "/repo",
      branchName: "feature/new-pr-flow",
      baseBranch: "main",
      commitLog: "abc123 feat: improve flow",
      reasoningMode: "auto",
      regenerateFeedback: "make testing section stronger",
    },
    fetchImpl,
  );

  const messages = body?.messages as Array<{ role: string; content: string }>;
  assert.ok(messages[1].content.includes("make testing section stronger"));
});
