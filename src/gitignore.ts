import fs from "node:fs";
import path from "node:path";

import { UserError } from "./errors.ts";
import type { CommandDependencies } from "./types.ts";

type IgnoreSection = {
  title: string;
  entries: string[];
};

export async function runGitignoreFlow(options: {
  cwd: string;
  output: CommandDependencies["output"];
  prompt: NonNullable<CommandDependencies["prompt"]>;
  autoConfirm: boolean;
}): Promise<void> {
  const projectRoot = options.cwd;
  const sections = detectIgnoreSections(projectRoot);
  const result = buildGitignoreUpdate(projectRoot, sections);

  if (options.output?.headline) {
    options.output.headline("AutoGit Gitignore");
  } else {
    options.output?.info("AutoGit Gitignore");
  }

  if (options.output?.keyValue) {
    options.output.keyValue("Project", path.basename(projectRoot));
    options.output.keyValue("Sections", String(sections.length));
  } else {
    options.output?.info(`Project: ${path.basename(projectRoot)}`);
    options.output?.info(`Sections: ${sections.length}`);
  }
  options.output?.info("");

  if (result.addedEntries.length === 0) {
    if (options.output?.success) {
      options.output.success(".gitignore is already up to date.");
    } else {
      options.output?.info(".gitignore is already up to date.");
    }
    return;
  }

  if (options.output?.box) {
    options.output.box("Proposed .gitignore additions", result.preview);
  } else {
    options.output?.info("Proposed .gitignore additions:");
    options.output?.info("");
    options.output?.info(result.preview);
  }
  options.output?.info("");

  if (!options.autoConfirm) {
    const confirmed = await options.prompt.confirm("Write these entries to .gitignore?");
    if (!confirmed) {
      throw new UserError("gitignore update aborted.");
    }
  }

  fs.writeFileSync(result.filePath, result.nextContent, "utf8");
  if (options.output?.success) {
    options.output.success(`Updated .gitignore with ${result.addedEntries.length} entries.`);
  } else {
    options.output?.info(`Updated .gitignore with ${result.addedEntries.length} entries.`);
  }
}

export function detectIgnoreSections(projectRoot: string): IgnoreSection[] {
  const sections: IgnoreSection[] = [
    {
      title: "OS files",
      entries: [".DS_Store", "Thumbs.db"],
    },
    {
      title: "Environment files",
      entries: [".env", ".env.*", "!.env.example", "!.env.sample"],
    },
    {
      title: "Logs",
      entries: ["*.log"],
    },
  ];

  if (hasAny(projectRoot, ["package.json", "package-lock.json", "tsconfig.json", "node_modules"])) {
    sections.push({
      title: "Node.js",
      entries: [
        "node_modules/",
        "dist/",
        "build/",
        "coverage/",
        ".next/",
        ".turbo/",
        "*.tsbuildinfo",
      ],
    });
  }

  if (
    hasAny(projectRoot, [
      "pyproject.toml",
      "requirements.txt",
      "setup.py",
      "Pipfile",
      ".venv",
      "venv",
    ])
  ) {
    sections.push({
      title: "Python",
      entries: [
        "__pycache__/",
        "*.py[cod]",
        ".venv/",
        "venv/",
        ".pytest_cache/",
        ".mypy_cache/",
      ],
    });
  }

  if (hasAny(projectRoot, ["Cargo.toml"])) {
    sections.push({
      title: "Rust",
      entries: ["target/"],
    });
  }

  return sections;
}

export function buildGitignoreUpdate(
  projectRoot: string,
  sections: IgnoreSection[],
): {
  addedEntries: string[];
  filePath: string;
  nextContent: string;
  preview: string;
} {
  const filePath = path.join(projectRoot, ".gitignore");
  const currentContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const newline = currentContent.includes("\r\n") ? "\r\n" : "\n";
  const existingLines = new Set(currentContent.split(/\r?\n/));

  const additions = sections
    .map((section) => ({
      title: section.title,
      entries: section.entries.filter((entry) => !existingLines.has(entry)),
    }))
    .filter((section) => section.entries.length > 0);

  const addedEntries = additions.flatMap((section) => section.entries);
  const preview = renderSections(additions, "\n");

  if (addedEntries.length === 0) {
    return {
      addedEntries,
      filePath,
      nextContent: currentContent,
      preview,
    };
  }

  const additionBlock = renderSections(additions, newline);
  const separator = currentContent.length === 0 ? "" : currentContent.endsWith(newline) ? newline : `${newline}${newline}`;
  const nextContent = `${currentContent}${separator}${additionBlock}${newline}`;

  return {
    addedEntries,
    filePath,
    nextContent,
    preview,
  };
}

function renderSections(
  sections: Array<{ title: string; entries: string[] }>,
  newline: string,
): string {
  return sections
    .map((section) => [`# ${section.title}`, ...section.entries].join(newline))
    .join(`${newline}${newline}`);
}

function hasAny(projectRoot: string, names: string[]): boolean {
  return names.some((name) => fs.existsSync(path.join(projectRoot, name)));
}
