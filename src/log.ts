import pino from "pino";

export type Logger = pino.Logger;

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined, // drop pid/hostname noise; journald adds its own
});

/** Child logger carrying a correlation id for one job. */
export function jobLogger(base: Logger, correlationId: string): Logger {
  return base.child({ cid: correlationId });
}
