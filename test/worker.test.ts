import { describe, it, expect, vi } from "vitest";
import { createWorker, buildResultComment, buildMrDescription } from "../src/worker";
import { buildPrompt } from "../src/claude";
import type { ClaudeResult } from "../src/claude";
import { parseConfig } from "../src/config";
import type { Job } from "../src/queue";
import type { IssueJobPayload } from "../src/webhook";
import pino from "pino";

const logger = pino({ level: "silent" });

const config = parseConfig({
  GITLAB_BASE_URL: "https://gitlab.example.com",
  GITLAB_WEBHOOK_SECRET: "s",
  GITLAB_BOT_TOKEN: "tok",
  ANTHROPIC_API_KEY: "key",
} as NodeJS.ProcessEnv);

const payload: IssueJobPayload = {
  projectId: 7,
  issueIid: 42,
  title: "Fix the bug",
  description: "there is a bug",
  projectPath: "group/repo",
  dedupeKey: "7:42:assigned",
};

const job: Job = {
  id: "job-1",
  dedupeKey: payload.dedupeKey,
  payload,
  status: "running",
  attempts: 1,
  createdAt: 0,
  updatedAt: 0,
};

function mocks(overrides: { hasChanges?: boolean; claudeOk?: boolean } = {}) {
  const gitlab = {
    commentOnIssue: vi.fn(async () => {}),
    defaultBranch: vi.fn(async () => "main"),
    createMergeRequest: vi.fn(async () => ({ iid: 3, web_url: "https://mr/3" })),
    currentUser: vi.fn(),
  };
  const cleanup = vi.fn(async () => {});
  const git = {
    ensureMirror: vi.fn(async () => "mirror"),
    createWorktree: vi.fn(async () => ({ dir: "/wt", branch: "claude/issue-42-fix-the-bug", cleanup })),
    hasChanges: vi.fn(async () => overrides.hasChanges ?? true),
    commitAll: vi.fn(async () => {}),
    push: vi.fn(async () => {}),
  };
  const result: ClaudeResult = {
    summary: "Made a fix.",
    ok: overrides.claudeOk ?? true,
    turns: 3,
    usage: { inputTokens: 100, outputTokens: 50 },
  };
  const runClaude = vi.fn(async () => result);
  return { gitlab, git, runClaude, cleanup };
}

describe("buildPrompt", () => {
  it("includes issue number, title and description", () => {
    const p = buildPrompt(payload);
    expect(p).toContain("#42: Fix the bug");
    expect(p).toContain("there is a bug");
    expect(p).toContain("Follow CLAUDE.md");
  });
  it("handles empty descriptions", () => {
    expect(buildPrompt({ ...payload, description: "" })).toContain("(no description provided)");
  });
});

describe("buildResultComment / buildMrDescription", () => {
  it("summarises the MR and token usage", () => {
    const comment = buildResultComment("https://mr/3", {
      summary: "Did it",
      ok: true,
      turns: 1,
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    expect(comment).toContain("https://mr/3");
    expect(comment).toContain("10 in / 20 out");
  });
  it("MR description closes the issue", () => {
    expect(buildMrDescription(42, { summary: "x", ok: true, turns: 1 })).toContain("Closes #42");
  });
});

describe("worker pipeline", () => {
  it("runs the happy path: ack, worktree, claude, commit, push, MR, comment", async () => {
    const m = mocks({ hasChanges: true });
    const handle = createWorker({ config, logger, ...m });
    await handle(job);

    expect(m.gitlab.commentOnIssue).toHaveBeenCalledWith(7, 42, expect.stringContaining("On it"));
    expect(m.git.ensureMirror).toHaveBeenCalled();
    expect(m.runClaude).toHaveBeenCalledWith(expect.objectContaining({ worktreeDir: "/wt" }));
    expect(m.git.commitAll).toHaveBeenCalledWith("/wt", expect.stringContaining("Closes #42"));
    expect(m.git.push).toHaveBeenCalledWith("/wt", "claude/issue-42-fix-the-bug");
    expect(m.gitlab.createMergeRequest).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ sourceBranch: "claude/issue-42-fix-the-bug", targetBranch: "main" }),
    );
    expect(m.gitlab.commentOnIssue).toHaveBeenCalledWith(7, 42, expect.stringContaining("https://mr/3"));
    expect(m.cleanup).toHaveBeenCalled();
  });

  it("skips MR creation when there are no changes", async () => {
    const m = mocks({ hasChanges: false });
    const handle = createWorker({ config, logger, ...m });
    await handle(job);

    expect(m.git.push).not.toHaveBeenCalled();
    expect(m.gitlab.createMergeRequest).not.toHaveBeenCalled();
    expect(m.gitlab.commentOnIssue).toHaveBeenCalledWith(7, 42, expect.stringContaining("no changes"));
    expect(m.cleanup).toHaveBeenCalled();
  });

  it("posts a failure comment and rethrows when a step throws", async () => {
    const m = mocks({ hasChanges: true });
    m.git.push.mockRejectedValueOnce(new Error("push failed"));
    const handle = createWorker({ config, logger, ...m });

    await expect(handle(job)).rejects.toThrow("push failed");
    expect(m.gitlab.commentOnIssue).toHaveBeenCalledWith(7, 42, expect.stringContaining("went wrong"));
    expect(m.cleanup).toHaveBeenCalled();
  });
});
