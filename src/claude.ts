import type { Logger } from "./log";
import type { IssueJobPayload } from "./webhook";

export interface ClaudeResult {
  /** Final assistant text / result summary, if any. */
  summary: string;
  /** Whether the run completed without erroring out. */
  ok: boolean;
  /** Approximate token usage, when reported by the SDK. */
  usage?: { inputTokens?: number; outputTokens?: number };
  turns: number;
}

/** Build the prompt handed to Claude for a given issue. */
export function buildPrompt(issue: IssueJobPayload): string {
  return [
    `You are implementing a GitLab issue in this repository.`,
    ``,
    `# Issue #${issue.issueIid}: ${issue.title}`,
    ``,
    issue.description?.trim() || "(no description provided)",
    ``,
    `Implement the change in this repository. Follow CLAUDE.md if present.`,
    `Run the project's tests before finishing. Do not touch unrelated files.`,
    `When done, summarise what you changed and why.`,
  ].join("\n");
}

export interface RunClaudeOptions {
  worktreeDir: string;
  issue: IssueJobPayload;
  maxTurns: number;
  model?: string;
  timeoutMs: number;
  logger: Logger;
}

/**
 * Run the Claude Agent SDK headless inside a worktree.
 *
 * The SDK is loaded dynamically so this CommonJS build interops cleanly with the
 * ESM-only package, and so tests can run without the dependency installed.
 */
export async function runClaude(opts: RunClaudeOptions): Promise<ClaudeResult> {
  const { query } = (await import("@anthropic-ai/claude-agent-sdk")) as typeof import("@anthropic-ai/claude-agent-sdk");

  const prompt = buildPrompt(opts.issue);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  let summary = "";
  let turns = 0;
  let usage: ClaudeResult["usage"];
  let ok = true;

  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd: opts.worktreeDir,
        permissionMode: "acceptEdits",
        allowedTools: ["Bash", "Read", "Edit", "Write", "Grep", "Glob"],
        maxTurns: opts.maxTurns,
        ...(opts.model ? { model: opts.model } : {}),
        abortController: controller,
      } as Record<string, unknown>,
    }) as AsyncIterable<Record<string, any>>) {
      if (msg.type === "assistant") turns += 1;
      if (msg.type === "result") {
        summary = typeof msg.result === "string" ? msg.result : summary;
        if (msg.subtype && msg.subtype !== "success") ok = false;
        if (msg.usage) {
          usage = {
            inputTokens: msg.usage.input_tokens,
            outputTokens: msg.usage.output_tokens,
          };
        }
      }
    }
  } catch (err) {
    opts.logger.error({ err }, "claude run errored");
    ok = false;
    summary = summary || (err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }

  return { summary, ok, usage, turns };
}
