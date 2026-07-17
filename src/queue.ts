import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "./log";
import type { JobPayload } from "./webhook";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  dedupeKey: string;
  payload: JobPayload;
  status: JobStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface EnqueueResult {
  accepted: boolean;
  job?: Job;
  /** Set when rejected: the reason (currently only "duplicate"). */
  reason?: "duplicate";
}

export type JobHandler = (job: Job) => Promise<void>;

interface QueueOptions {
  filePath: string;
  concurrency: number;
  handler: JobHandler;
  logger: Logger;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * In-process job queue persisted to a JSON file.
 *
 * - Bounded concurrency: at most `concurrency` handlers run at once.
 * - Dedupe: an enqueue whose key matches an already queued/running job is dropped.
 * - Durability: queued + running jobs are persisted; on restart, `running` jobs are
 *   reset to `queued` so an interrupted backlog is retried.
 * - Completed (`done`) jobs are pruned; `failed` jobs are retained for visibility.
 */
export class JobQueue {
  private jobs: Job[] = [];
  private readonly running = new Set<string>();
  private readonly filePath: string;
  private readonly concurrency: number;
  private readonly handler: JobHandler;
  private readonly logger: Logger;
  private readonly now: () => number;
  private started = false;
  /** Serialises persistence writes so concurrent saves don't interleave. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: QueueOptions) {
    this.filePath = opts.filePath;
    this.concurrency = opts.concurrency;
    this.handler = opts.handler;
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
  }

  /** Load persisted state from disk (if any) and recover interrupted jobs. */
  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { jobs?: Job[] };
      this.jobs = (parsed.jobs ?? []).map((j) =>
        j.status === "running" ? { ...j, status: "queued" as const } : j,
      );
      const recovered = this.jobs.filter((j) => j.status === "queued").length;
      if (recovered > 0) this.logger.info({ recovered }, "recovered queued jobs from disk");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn({ err }, "could not read queue file; starting empty");
      }
      this.jobs = [];
    }
    this.started = true;
    void this.drain();
  }

  /** Enqueue a job unless an active (queued/running) job with the same key exists. */
  enqueue(payload: JobPayload): EnqueueResult {
    const existing = this.jobs.find(
      (j) =>
        j.dedupeKey === payload.dedupeKey &&
        (j.status === "queued" || j.status === "running"),
    );
    if (existing) return { accepted: false, reason: "duplicate" };

    const ts = this.now();
    const job: Job = {
      id: randomUUID(),
      dedupeKey: payload.dedupeKey,
      payload,
      status: "queued",
      attempts: 0,
      createdAt: ts,
      updatedAt: ts,
    };
    this.jobs.push(job);
    void this.persist();
    if (this.started) void this.drain();
    return { accepted: true, job };
  }

  /** Number of jobs currently queued or running. */
  size(): number {
    return this.jobs.filter((j) => j.status === "queued" || j.status === "running").length;
  }

  /** Count of jobs ahead of a hypothetical new job (for backpressure messaging). */
  pending(): number {
    return this.jobs.filter((j) => j.status === "queued").length;
  }

  snapshot(): ReadonlyArray<Job> {
    return this.jobs.map((j) => ({ ...j }));
  }

  /** Fill available worker slots with queued jobs. */
  private drain(): void {
    while (this.running.size < this.concurrency) {
      const next = this.jobs.find((j) => j.status === "queued");
      if (!next) break;
      this.run(next);
    }
  }

  private run(job: Job): void {
    job.status = "running";
    job.attempts += 1;
    job.updatedAt = this.now();
    this.running.add(job.id);
    void this.persist();

    this.handler(job)
      .then(() => {
        job.status = "done";
      })
      .catch((err: unknown) => {
        job.status = "failed";
        this.logger.error({ err, jobId: job.id }, "job handler threw");
      })
      .finally(() => {
        job.updatedAt = this.now();
        this.running.delete(job.id);
        // Prune completed jobs; keep failed ones for visibility.
        this.jobs = this.jobs.filter((j) => j.status !== "done");
        void this.persist();
        this.drain();
      });
  }

  private persist(): Promise<void> {
    // Only durable state matters: queued/running (persisted as queued) + failed.
    const toPersist = this.jobs.filter((j) => j.status !== "done");
    const data = JSON.stringify({ jobs: toPersist }, null, 2);
    this.writeChain = this.writeChain
      .then(async () => {
        await fs.mkdir(dirname(this.filePath), { recursive: true });
        await fs.writeFile(this.filePath, data, "utf8");
      })
      .catch((err: unknown) => {
        this.logger.error({ err }, "failed to persist queue");
      });
    return this.writeChain;
  }

  /** Wait for all in-flight and queued work to finish (test/shutdown helper). */
  async drainToIdle(): Promise<void> {
    // Poll until nothing is queued or running.
    while (this.size() > 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await this.writeChain;
  }
}
