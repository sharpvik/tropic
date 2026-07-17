import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JobQueue } from "../src/queue";
import type { IssueJobPayload } from "../src/webhook";
import pino from "pino";

const logger = pino({ level: "silent" });

function payload(iid: number): IssueJobPayload {
  return {
    projectId: 1,
    issueIid: iid,
    title: `Issue ${iid}`,
    description: "",
    projectPath: "g/r",
    dedupeKey: `1:${iid}:assigned`,
  };
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "queue-test-"));
  file = join(dir, "queue.json");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("JobQueue", () => {
  it("processes an enqueued job", async () => {
    const seen: number[] = [];
    const q = new JobQueue({
      filePath: file,
      concurrency: 2,
      logger,
      handler: async (job) => {
        seen.push(job.payload.issueIid);
      },
    });
    await q.init();
    q.enqueue(payload(1));
    await q.drainToIdle();
    expect(seen).toEqual([1]);
  });

  it("dedupes jobs with the same key while active", () => {
    const q = new JobQueue({
      filePath: file,
      concurrency: 1,
      logger,
      handler: () => new Promise(() => {}), // never resolves; keeps job running
    });
    // Not initialised (so it won't drain), enqueue twice.
    const first = q.enqueue(payload(1));
    const second = q.enqueue(payload(1));
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.reason).toBe("duplicate");
    expect(q.size()).toBe(1);
  });

  it("respects the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const q = new JobQueue({
      filePath: file,
      concurrency: 2,
      logger,
      handler: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await gate;
        active--;
      },
    });
    await q.init();
    q.enqueue(payload(1));
    q.enqueue(payload(2));
    q.enqueue(payload(3));
    // Let the loop schedule work.
    await new Promise((r) => setTimeout(r, 20));
    expect(maxActive).toBe(2);
    release();
    await q.drainToIdle();
    expect(maxActive).toBe(2);
  });

  it("persists queued jobs and recovers them on restart", async () => {
    // First queue: handler blocks so the job stays queued/running and is persisted.
    const q1 = new JobQueue({
      filePath: file,
      concurrency: 1,
      logger,
      handler: () => new Promise(() => {}),
    });
    q1.enqueue(payload(5)); // not init'd -> stays queued, persisted
    // Give persist() a tick.
    await new Promise((r) => setTimeout(r, 20));

    const onDisk = JSON.parse(await fs.readFile(file, "utf8"));
    expect(onDisk.jobs).toHaveLength(1);
    expect(onDisk.jobs[0].payload.issueIid).toBe(5);

    // Second queue restarts from the same file and should process the recovered job.
    const seen: number[] = [];
    const q2 = new JobQueue({
      filePath: file,
      concurrency: 1,
      logger,
      handler: async (job) => {
        seen.push(job.payload.issueIid);
      },
    });
    await q2.init();
    await q2.drainToIdle();
    expect(seen).toEqual([5]);
  });

  it("marks a throwing handler as failed and continues", async () => {
    const seen: number[] = [];
    const q = new JobQueue({
      filePath: file,
      concurrency: 1,
      logger,
      handler: async (job) => {
        if (job.payload.issueIid === 1) throw new Error("boom");
        seen.push(job.payload.issueIid);
      },
    });
    await q.init();
    q.enqueue(payload(1));
    q.enqueue(payload(2));
    await q.drainToIdle();
    expect(seen).toEqual([2]);
    // Failed job is retained in the snapshot.
    expect(q.snapshot().some((j) => j.status === "failed")).toBe(true);
  });
});
