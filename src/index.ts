import { join } from "node:path";
import { parseConfig } from "./config";
import { logger } from "./log";
import { JobQueue } from "./queue";
import { GitLabClient } from "./gitlab";
import { GitOps } from "./git";
import { runClaude } from "./claude";
import { createWorker } from "./worker";
import { createServer } from "./server";

async function main(): Promise<void> {
  const config = parseConfig();

  const gitlab = new GitLabClient({
    baseUrl: config.GITLAB_BASE_URL,
    token: config.GITLAB_BOT_TOKEN,
    logger,
  });

  const git = new GitOps({
    workspacesDir: config.WORKSPACES_DIR,
    botUsername: config.BOT_GIT_USERNAME,
    botEmail: config.BOT_GIT_EMAIL,
    logger,
  });

  const worker = createWorker({ config, gitlab, git, runClaude, logger });

  const queue = new JobQueue({
    filePath: join(config.DATA_DIR, "queue.json"),
    concurrency: config.MAX_CONCURRENCY,
    handler: worker,
    logger,
  });
  await queue.init();

  const app = createServer({ config, queue, logger });
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "tropic listening");
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close(() => process.exit(0));
    // Force-exit if graceful close hangs.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err }, "fatal boot error");
  process.exit(1);
});
