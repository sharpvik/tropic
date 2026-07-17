import type { Logger } from "./log";
import type { IssueJobPayload, MrCommentJobPayload } from "./webhook";

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

/** Build the prompt for iterating on an open MR in response to a reviewer comment. */
export function buildMrCommentPrompt(job: MrCommentJobPayload): string {
  // The bot's own username in the mention is noise; leave the rest of the comment intact.
  return [
    `You are iterating on an open GitLab merge request in this repository.`,
    `The MR's branch is already checked out.`,
    ``,
    `# MR !${job.mrIid}: ${job.title}`,
    ``,
    `A reviewer left this comment mentioning you:`,
    ``,
    job.comment.trim() || "(empty comment)",
    ``,
    `Address the comment by editing this repository. Follow CLAUDE.md if present.`,
    `Run the project's tests before finishing. Do not touch unrelated files.`,
    `When done, summarise what you changed and why.`,
  ].join("\n");
}

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

function truncate(s: string, n = 200): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

/** A one-line summary of a tool call's input, for the activity log. */
function summariseToolInput(name: string, input: Record<string, any> | undefined): string {
  if (!input) return "";
  switch (name) {
    case "Bash":
      return truncate(String(input.command ?? ""), 200);
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return String(input.file_path ?? input.notebook_path ?? "");
    case "Grep":
      return truncate(`${input.pattern ?? ""} ${input.path ? `in ${input.path}` : ""}`);
    case "Glob":
      return truncate(String(input.pattern ?? ""));
    case "TodoWrite":
      return `${(input.todos ?? []).length} todo(s)`;
    case "Task":
      return truncate(String(input.description ?? input.prompt ?? ""));
    case "WebFetch":
    case "WebSearch":
      return truncate(String(input.url ?? input.query ?? ""));
    default:
      return truncate(JSON.stringify(input), 160);
  }
}

/** Stream the agent's tool calls + text to the logs so progress is visible live. */
function logAssistant(logger: Logger, msg: Record<string, any>): void {
  const blocks = msg?.message?.content;
  if (!Array.isArray(blocks)) return;
  for (const b of blocks) {
    if (b?.type === "tool_use") {
      logger.info({ tool: b.name, detail: summariseToolInput(b.name, b.input) }, "🔧 tool");
    } else if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
      logger.info({ text: truncate(b.text, 300) }, "💬 claude");
    }
  }
}

export interface RunClaudeOptions {
  worktreeDir: string;
  /** The fully-built prompt to run. */
  prompt: string;
  model?: string;
  /** Reasoning effort level. */
  effort: EffortLevel;
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

  const prompt = opts.prompt;
  const controller = new AbortController();
  // Wall-clock safety net. JOB_TIMEOUT_MS=0 disables it entirely (run unbounded).
  const timer =
    opts.timeoutMs > 0 ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined;

  let summary = "";
  let turns = 0;
  let usage: ClaudeResult["usage"];
  let ok = true;

  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd: opts.worktreeDir,
        // Use Claude Code's real system prompt (not a bare one) — this is what makes
        // the agent behave like Claude Code rather than a model with a few tools.
        systemPrompt: { type: "preset", preset: "claude_code" },
        // Load project settings so repo CLAUDE.md / .claude config apply.
        settingSources: ["project"],
        // Run fully autonomous: pre-approve every tool (no interactive prompts). Safe
        // because each job runs in an isolated container + throwaway git worktree.
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // No allowedTools restriction → the full default toolset (Bash, Edit, Write,
        // Read, Grep, Glob, TodoWrite, Task/subagents, WebFetch, WebSearch, Skills…).
        // No maxTurns → the agent runs until the task is actually done.
        effort: opts.effort,
        ...(opts.model ? { model: opts.model } : {}),
        abortController: controller,
      } as Record<string, unknown>,
    }) as AsyncIterable<Record<string, any>>) {
      if (msg.type === "assistant") {
        turns += 1;
        logAssistant(opts.logger, msg);
      }
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
    if (timer) clearTimeout(timer);
  }

  return { summary, ok, usage, turns };
}
