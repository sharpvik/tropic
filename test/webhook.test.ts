import { describe, it, expect } from "vitest";
import { parseAssignmentHook } from "../src/webhook";

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
      dedupeKey: "7:42:assigned",
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
    expect(job).toMatchObject({ issueIid: 42, dedupeKey: "7:42:assigned" });
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
