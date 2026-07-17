import { describe, it, expect } from "vitest";
import { parseConfig, isProjectAllowed } from "../src/config";

const base = {
  GITLAB_BASE_URL: "https://gitlab.example.com",
  GITLAB_WEBHOOK_SECRET: "secret",
  GITLAB_BOT_TOKEN: "token",
  ANTHROPIC_API_KEY: "key",
} as NodeJS.ProcessEnv;

describe("parseConfig", () => {
  it("applies defaults for optional values", () => {
    const c = parseConfig(base);
    expect(c.PORT).toBe(8080);
    expect(c.CLAUDE_BOT_USERNAME).toBe("claude-bot");
    expect(c.MAX_CONCURRENCY).toBe(2);
    expect(c.ALLOWED_PROJECTS).toEqual([]);
  });

  it("coerces numeric strings", () => {
    const c = parseConfig({ ...base, PORT: "3000", MAX_CONCURRENCY: "4" });
    expect(c.PORT).toBe(3000);
    expect(c.MAX_CONCURRENCY).toBe(4);
  });

  it("parses ALLOWED_PROJECTS into a numeric array", () => {
    const c = parseConfig({ ...base, ALLOWED_PROJECTS: "1, 2 ,3" });
    expect(c.ALLOWED_PROJECTS).toEqual([1, 2, 3]);
  });

  it("throws on missing required values", () => {
    expect(() => parseConfig({ GITLAB_BASE_URL: "https://x.com" } as NodeJS.ProcessEnv)).toThrow(
      /Invalid configuration/,
    );
  });

  it("throws on an invalid base URL", () => {
    expect(() => parseConfig({ ...base, GITLAB_BASE_URL: "not-a-url" })).toThrow();
  });
});

describe("isProjectAllowed", () => {
  it("allows all when the allowlist is empty", () => {
    const c = parseConfig(base);
    expect(isProjectAllowed(c, 999)).toBe(true);
  });

  it("restricts to listed projects when set", () => {
    const c = parseConfig({ ...base, ALLOWED_PROJECTS: "42,101" });
    expect(isProjectAllowed(c, 42)).toBe(true);
    expect(isProjectAllowed(c, 7)).toBe(false);
  });
});
