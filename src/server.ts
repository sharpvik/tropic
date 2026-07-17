import { timingSafeEqual } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import type { Config } from "./config";
import { isProjectAllowed } from "./config";
import { parseAssignmentHook } from "./webhook";
import type { JobQueue } from "./queue";
import type { Logger } from "./log";

/** Constant-time comparison of the webhook token. */
export function verifyToken(expected: string, received: string | undefined): boolean {
  if (!received) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false; // timingSafeEqual requires equal length
  return timingSafeEqual(a, b);
}

interface ServerDeps {
  config: Config;
  queue: JobQueue;
  logger: Logger;
}

export function createServer(deps: ServerDeps): Express {
  const { config, queue, logger } = deps;
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", pending: queue.pending(), active: queue.size() });
  });

  app.post("/webhook", (req: Request, res: Response) => {
    const token = req.header("X-Gitlab-Token");
    if (!verifyToken(config.GITLAB_WEBHOOK_SECRET, token)) {
      logger.warn("rejected webhook: bad token");
      res.status(401).json({ error: "invalid token" });
      return;
    }

    const job = parseAssignmentHook(req.body, config.CLAUDE_BOT_USERNAME);
    if (!job) {
      // Valid request, just not an event we act on.
      res.status(200).json({ ignored: true });
      return;
    }

    if (!isProjectAllowed(config, job.projectId)) {
      logger.warn({ project: job.projectId }, "project not in allowlist; ignoring");
      res.status(200).json({ ignored: true, reason: "project not allowed" });
      return;
    }

    const result = queue.enqueue(job);
    if (!result.accepted) {
      logger.info({ dedupeKey: job.dedupeKey }, "duplicate job dropped");
      res.status(200).json({ accepted: false, reason: result.reason });
      return;
    }

    logger.info(
      { jobId: result.job?.id, issue: job.issueIid, project: job.projectPath },
      "job enqueued",
    );
    res.status(202).json({ accepted: true, jobId: result.job?.id, ahead: queue.pending() - 1 });
  });

  return app;
}
