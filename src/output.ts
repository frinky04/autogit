import readline from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";

import type { CommitAction, ConfirmOptions, OutputWriter, PrAction, PromptHandler } from "./types.ts";

export function createConsoleOutput(): OutputWriter {
  const spinnerFrames = ["-", "\\", "|", "/"];
  let spinnerTimer: NodeJS.Timeout | undefined;
  let spinnerFrameIndex = 0;
  let spinnerMessage = "";
  const useColor = Boolean(stdout.isTTY && !process.env.NO_COLOR);

  function format(text: string, codes: number[]): string {
    if (!useColor) {
      return text;
    }

    return `\x1b[${codes.join(";")}m${text}\x1b[0m`;
  }

  function clearSpinnerLine(): void {
    if (!stdout.isTTY) {
      return;
    }

    stdout.write("\r\x1b[2K");
  }

  function renderSpinner(): void {
    if (!stdout.isTTY || !spinnerTimer) {
      return;
    }

    const frame = spinnerFrames[spinnerFrameIndex % spinnerFrames.length];
    spinnerFrameIndex += 1;
    stdout.write(`\r${frame} ${spinnerMessage}`);
  }

  function pauseSpinner(): void {
    if (!spinnerTimer) {
      return;
    }

    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
    clearSpinnerLine();
  }

  return {
    info(message: string) {
      pauseSpinner();
      stdout.write(`${message}\n`);
    },
    error(message: string) {
      pauseSpinner();
      stderr.write(`${message}\n`);
    },
    stream(chunk: string) {
      pauseSpinner();
      stdout.write(chunk);
    },
    endStream() {
      pauseSpinner();
      stdout.write("\n");
    },
    startSpinner(message: string) {
      pauseSpinner();
      spinnerMessage = message;
      spinnerFrameIndex = 0;

      if (!stdout.isTTY) {
        stdout.write(`${message}...\n`);
        return;
      }

      spinnerTimer = setInterval(renderSpinner, 80);
      renderSpinner();
    },
    stopSpinner() {
      pauseSpinner();
    },
    headline(message: string) {
      pauseSpinner();
      stdout.write(`${format(message, [1, 36])}\n`);
    },
    keyValue(label: string, value: string) {
      pauseSpinner();
      stdout.write(`${format(label.padEnd(7), [2, 37])} ${value}\n`);
    },
    box(title: string, content: string) {
      pauseSpinner();
      const lines = content.split("\n");

      if (!stdout.isTTY) {
        stdout.write(`${title}\n${content}\n`);
        return;
      }

      stdout.write(`${format(`┌ ${title}`, [36])}\n`);
      for (const line of lines) {
        stdout.write(`${format("│", [36])} ${line}\n`);
      }
      stdout.write(`${format("└", [36])}\n`);
    },
    actionLine(items) {
      pauseSpinner();
      const rendered = items
        .map((item) => `${format(`[${item.key}]`, [1, 34])} ${item.label}`)
        .join("   ");
      stdout.write(`${rendered}\n`);
    },
    success(message: string) {
      pauseSpinner();
      stdout.write(`${format(message, [32])}\n`);
    },
    warn(message: string) {
      pauseSpinner();
      stdout.write(`${format(message, [33])}\n`);
    },
  };
}

export function createConsolePrompt(): PromptHandler {
  return {
    async confirm(message: string, options?: ConfirmOptions) {
      const defaultValue = options?.defaultValue ?? true;
      const suffix = defaultValue ? "[Y/n]" : "[y/N]";
      const answer = (await askLine(`${message} ${suffix} `)).trim();

      if (answer === "") {
        return defaultValue;
      }

      return /^y(es)?$/i.test(answer);
    },
    async chooseCommitAction(message: string) {
      const promptText = message.trim().length > 0 ? `${message} ` : "> ";
      const answer = (await askLine(promptText)).trim().toLowerCase();

      const actionMap: Record<string, CommitAction> = {
        "": "commit",
        p: "push",
        b: "branch",
        e: "edit",
        r: "regenerate",
        c: "cancel",
      };

      return actionMap[answer] ?? "cancel";
    },
    async choosePrAction(message: string) {
      const promptText = message.trim().length > 0 ? `${message} ` : "> ";
      const answer = (await askLine(promptText)).trim().toLowerCase();

      const actionMap: Record<string, PrAction> = {
        "": "create",
        r: "regenerate",
        c: "cancel",
      };

      return actionMap[answer] ?? "cancel";
    },
    async editMessage(message: string) {
      stdout.write(
        "Edit commit message. Enter lines below and finish with a single '.' on its own line.\n",
      );
      stdout.write("Press Enter on the first line to keep the current message.\n");

      const rl = readline.createInterface({ input: stdin, output: stdout });
      const lines: string[] = [];

      try {
        while (true) {
          const line = await rl.question(lines.length === 0 ? "> " : "");

          if (lines.length === 0 && line === "") {
            return message;
          }

          if (line === ".") {
            break;
          }

          lines.push(line);
        }
      } finally {
        rl.close();
      }

      const edited = lines.join("\n").trim();
      return edited || null;
    },
    async input(message: string) {
      return askLine(message);
    },
  };
}

export function createNoopOutput(): OutputWriter {
  const noop = () => {};
  return {
    info: noop,
    error: noop,
    stream: noop,
    endStream: noop,
    startSpinner: noop,
    stopSpinner: noop,
    headline: noop,
    keyValue: noop,
    box: noop,
    actionLine: noop,
    success: noop,
    warn: noop,
  };
}

export function emitSuccess(output: OutputWriter, message: string): void {
  output.success(message);
}

export function emitWarn(output: OutputWriter, message: string): void {
  output.warn(message);
}

async function askLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}
