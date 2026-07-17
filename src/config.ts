import { z } from "zod";

/**
 * Environment schema. Kept as a pure function of an env-like object so it can be
 * unit-tested without mutating `process.env`.
 */
const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),

  GITLAB_BASE_URL: z.string().url(),
  GITLAB_WEBHOOK_SECRET: z.string().min(1, "GITLAB_WEBHOOK_SECRET is required"),
  GITLAB_BOT_TOKEN: z.string().min(1, "GITLAB_BOT_TOKEN is required"),
  CLAUDE_BOT_USERNAME: z.string().min(1).default("claude-bot"),

  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  ANTHROPIC_MODEL: z.string().min(1).optional(),

  MAX_CONCURRENCY: z.coerce.number().int().positive().default(2),
  // Wall-clock cap per job in ms; generous by default (4h). 0 disables it entirely.
  JOB_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(14_400_000),

  WORKSPACES_DIR: z.string().min(1).default("./workspaces"),
  DATA_DIR: z.string().min(1).default("./data"),

  BOT_GIT_USERNAME: z.string().min(1).default("claude-bot"),
  BOT_GIT_EMAIL: z.string().min(1).default("claude-bot@example.com"),

  ALLOWED_PROJECTS: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isFinite(n))
        : [],
    ),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Parse & validate config from an env object (defaults to process.env). */
export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

/** True when the project is permitted to be acted on (empty allowlist = allow all). */
export function isProjectAllowed(config: Config, projectId: number): boolean {
  return config.ALLOWED_PROJECTS.length === 0 || config.ALLOWED_PROJECTS.includes(projectId);
}
