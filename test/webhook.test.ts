import { describe, it, expect } from "vitest";
import { parseAssignmentHook, parseNoteHook, mentionsUser } from "../src/webhook";

const BOT = "claude-bot";

function hook(overrides: Record<string, unknown> = {}) {
  return {
    object_kind: "issue",
    object_attributes: { iid: 42, action: "update", title: "Fix the bug", description: "details" },
    project: { id: 7, path_with_namespace: "group/repo" },
    assignees: [{ username: BOT }],
    changes: {
      assignees: {
        previous: [],
        current: [{ username: BOT }],
      },
    },
    ...overrides,
  };
}

describe("parseAssignmentHook", () => {
  it("fires on a clean false->true assignment to the bot", () => {
    const job = parseAssignmentHook(hook(), BOT);
    expect(job).not.toBeNull();
    expect(job).toMatchObject({
      projectId: 7,
      issueIid: 42,
      title: "Fix the bug",
      description: "details",
      projectPath: "group/repo",
      dedupeKey: "7:issue:42:assigned",
    });
  });

  it("does not fire when the bot was already assigned", () => {
    const job = parseAssignmentHook(
      hook({ changes: { assignees: { previous: [{ username: BOT }], current: [{ username: BOT }] } } }),
      BOT,
    );
    expect(job).toBeNull();
  });

  it("does not fire when the assignment is to someone else", () => {
    const job = parseAssignmentHook(
      hook({ changes: { assignees: { previous: [], current: [{ username: "alice" }] } } }),
      BOT,
    );
    expect(job).toBeNull();
  });

  it("does not fire when there is no assignee change", () => {
    const job = parseAssignmentHook(hook({ changes: {} }), BOT);
    expect(job).toBeNull();
  });

  it("does not fire on unassignment of the bot", () => {
    const job = parseAssignmentHook(
      hook({ changes: { assignees: { previous: [{ username: BOT }], current: [] } } }),
      BOT,
    );
    expect(job).toBeNull();
  });

  it("fires when an issue is created already assigned to the bot (action=open)", () => {
    const job = parseAssignmentHook(
      hook({
        object_attributes: { iid: 42, action: "open", title: "New", description: "d" },
        assignees: [{ username: BOT }],
        changes: {}, // no assignee transition on creation
      }),
      BOT,
    );
    expect(job).not.toBeNull();
    expect(job).toMatchObject({ issueIid: 42, dedupeKey: "7:issue:42:assigned" });
  });

  it("does not fire when an issue is created assigned to someone else", () => {
    const job = parseAssignmentHook(
      hook({
        object_attributes: { iid: 42, action: "open", title: "New" },
        assignees: [{ username: "alice" }],
        changes: {},
      }),
      BOT,
    );
    expect(job).toBeNull();
  });

  it("does not fire when an issue is created with no assignee", () => {
    const job = parseAssignmentHook(
      hook({
        object_attributes: { iid: 42, action: "open", title: "New" },
        assignees: [],
        changes: {},
      }),
      BOT,
    );
    expect(job).toBeNull();
  });

  it("ignores non-issue events", () => {
    expect(parseAssignmentHook(hook({ object_kind: "merge_request" }), BOT)).toBeNull();
  });

  it("ignores malformed payloads", () => {
    expect(parseAssignmentHook(null, BOT)).toBeNull();
    expect(parseAssignmentHook("nope", BOT)).toBeNull();
    expect(parseAssignmentHook(hook({ project: undefined }), BOT)).toBeNull();
  });

  it("falls back to a default title when missing", () => {
    const job = parseAssignmentHook(
      hook({ object_attributes: { iid: 9, action: "update" } }),
      BOT,
    );
    expect(job?.title).toBe("Issue #9");
    expect(job?.description).toBe("");
  });
});

const BOT_U = "claude-bot";

function noteHook(overrides: Record<string, unknown> = {}) {
  return {
    object_kind: "note",
    user: { username: "reviewer" },
    project: { id: 7, path_with_namespace: "group/repo" },
    object_attributes: {
      id: 555,
      note: "hey @claude-bot please fix the typo",
      noteable_type: "MergeRequest",
    },
    merge_request: { iid: 12, source_branch: "claude/issue-42-fix", title: "Fix the bug" },
    ...overrides,
  };
}

describe("mentionsUser", () => {
  it("matches an exact @mention", () => {
    expect(mentionsUser("please @claude-bot help", "claude-bot")).toBe(true);
    expect(mentionsUser("@claude-bot", "claude-bot")).toBe(true);
  });
  it("does not match a longer username or missing @", () => {
    expect(mentionsUser("@claude-bottom", "claude-bot")).toBe(false);
    expect(mentionsUser("claude-bot", "claude-bot")).toBe(false);
    expect(mentionsUser("email claude-bot@x.com", "claude-bot")).toBe(false);
  });
});

describe("parseNoteHook", () => {
  it("fires on an MR comment that mentions the bot", () => {
    const job = parseNoteHook(noteHook(), BOT_U);
    expect(job).toMatchObject({
      kind: "mr_comment",
      projectId: 7,
      projectPath: "group/repo",
      mrIid: 12,
      sourceBranch: "claude/issue-42-fix",
      dedupeKey: "7:mr:12:note:555",
    });
    expect(job?.comment).toContain("fix the typo");
  });

  it("ignores comments that don't mention the bot", () => {
    expect(parseNoteHook(noteHook({ object_attributes: { id: 1, note: "lgtm", noteable_type: "MergeRequest" } }), BOT_U)).toBeNull();
  });

  it("ignores the bot's own comments (no feedback loop)", () => {
    expect(parseNoteHook(noteHook({ user: { username: BOT_U } }), BOT_U)).toBeNull();
  });

  it("ignores non-MR notes (e.g. issue comments)", () => {
    expect(
      parseNoteHook(
        noteHook({ object_attributes: { id: 2, note: "@claude-bot", noteable_type: "Issue" } }),
        BOT_U,
      ),
    ).toBeNull();
  });

  it("ignores note hooks with no merge_request payload", () => {
    expect(parseNoteHook(noteHook({ merge_request: undefined }), BOT_U)).toBeNull();
  });

  it("ignores non-note events", () => {
    expect(parseNoteHook({ object_kind: "issue" }, BOT_U)).toBeNull();
  });
});
