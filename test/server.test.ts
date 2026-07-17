import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createServer, verifyToken } from "../src/server";
import { parseConfig } from "../src/config";
import { JobQueue } from "../src/queue";
import pino from "pino";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const logger = pino({ level: "silent" });

const config = parseConfig({
  GITLAB_BASE_URL: "https://gitlab.example.com",
  GITLAB_WEBHOOK_SECRET: "s3cret",
  GITLAB_BOT_TOKEN: "token",
  ANTHROPIC_API_KEY: "key",
  CLAUDE_BOT_USERNAME: "claude-bot",
  ALLOWED_PROJECTS: "7",
} as NodeJS.ProcessEnv);

function assignmentHook() {
  return {
    object_kind: "issue",
    object_attributes: { iid: 42, action: "update", title: "Fix", description: "d" },
    project: { id: 7, path_with_namespace: "group/repo" },
    changes: { assignees: { previous: [], current: [{ username: "claude-bot" }] } },
  };
}

describe("verifyToken", () => {
  it("accepts a matching token", () => {
    expect(verifyToken("abc", "abc")).toBe(true);
  });
  it("rejects a mismatch or missing token", () => {
    expect(verifyToken("abc", "abd")).toBe(false);
    expect(verifyToken("abc", undefined)).toBe(false);
    expect(verifyToken("abc", "abcd")).toBe(false);
  });
});

describe("server", () => {
  let queue: JobQueue;
  let enqueued: number[];

  beforeEach(async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "srv-test-"));
    enqueued = [];
    queue = new JobQueue({
      filePath: join(dir, "q.json"),
      concurrency: 1,
      logger,
      handler: async (job) => {
        enqueued.push(job.payload.issueIid);
      },
    });
    // Deliberately not init'd so jobs stay queued and we can inspect enqueue behaviour.
  });

  function app() {
    return createServer({ config, queue, logger });
  }

  it("healthz returns ok", async () => {
    const res = await request(app()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("rejects a webhook with a bad token", async () => {
    const res = await request(app())
      .post("/webhook")
      .set("X-Gitlab-Token", "wrong")
      .send(assignmentHook());
    expect(res.status).toBe(401);
  });

  it("accepts and enqueues a valid assignment", async () => {
    const res = await request(app())
      .post("/webhook")
      .set("X-Gitlab-Token", "s3cret")
      .send(assignmentHook());
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
    expect(queue.size()).toBe(1);
  });

  it("ignores non-assignment events with 200", async () => {
    const res = await request(app())
      .post("/webhook")
      .set("X-Gitlab-Token", "s3cret")
      .send({ object_kind: "issue", object_attributes: { iid: 1 }, project: { id: 7 } });
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe(true);
    expect(queue.size()).toBe(0);
  });

  it("ignores projects outside the allowlist", async () => {
    const hook = assignmentHook();
    hook.project.id = 999;
    const res = await request(app())
      .post("/webhook")
      .set("X-Gitlab-Token", "s3cret")
      .send(hook);
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe(true);
    expect(queue.size()).toBe(0);
  });

  it("drops duplicate assignments", async () => {
    await request(app()).post("/webhook").set("X-Gitlab-Token", "s3cret").send(assignmentHook());
    const res = await request(app())
      .post("/webhook")
      .set("X-Gitlab-Token", "s3cret")
      .send(assignmentHook());
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(false);
    expect(queue.size()).toBe(1);
  });
});
