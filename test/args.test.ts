import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs } from "../src/args.ts";

test("parseArgs handles commit flags", () => {
  const parsed = parseArgs([
    "commit",
    "--model",
    "openai/gpt-4o-mini",
    "--yes",
    "--all",
    "--reasoning",
  ]);

  assert.equal(parsed.name, "commit");
  assert.equal(parsed.flags.model, "openai/gpt-4o-mini");
  assert.equal(parsed.flags.yes, true);
  assert.equal(parsed.flags.all, true);
  assert.equal(parsed.flags.reasoning, true);
});

test("parseArgs handles no-reasoning flag", () => {
  const parsed = parseArgs(["commit", "--no-reasoning"]);

  assert.equal(parsed.name, "commit");
  assert.equal(parsed.flags["no-reasoning"], true);
});

test("parseArgs handles gitignore command", () => {
  const parsed = parseArgs(["gitignore", "--yes"]);

  assert.equal(parsed.name, "gitignore");
  assert.equal(parsed.flags.yes, true);
});

test("parseArgs handles publish command", () => {
  const parsed = parseArgs(["publish", "my-repo", "--public", "--yes"]);

  assert.equal(parsed.name, "publish");
  assert.equal(parsed.positionals[0], "my-repo");
  assert.equal(parsed.flags.public, true);
  assert.equal(parsed.flags.yes, true);
});

test("parseArgs handles status command", () => {
  const parsed = parseArgs(["status"]);

  assert.equal(parsed.name, "status");
});

test("parseArgs rejects unknown commands", () => {
  assert.throws(() => parseArgs(["guide"]), { name: "UserError" });
  assert.throws(() => parseArgs(["branch-commit"]), { name: "UserError" });
});
