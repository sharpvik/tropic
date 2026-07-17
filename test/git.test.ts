import { describe, it, expect } from "vitest";
import { slugify, branchName, authedRepoUrl, safeName } from "../src/git";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Fix the Login Bug!")).toBe("fix-the-login-bug");
  });
  it("trims leading/trailing separators", () => {
    expect(slugify("  --Hello--  ")).toBe("hello");
  });
  it("truncates to maxLen without trailing hyphen", () => {
    expect(slugify("a".repeat(50), 10)).toBe("aaaaaaaaaa");
    expect(slugify("word ".repeat(20), 12)).toBe("word-word-wo");
  });
  it("falls back to 'issue' for empty results", () => {
    expect(slugify("!!! ???")).toBe("issue");
  });
});

describe("branchName", () => {
  it("builds claude/issue-<iid>-<slug>", () => {
    expect(branchName(42, "Fix the bug")).toBe("claude/issue-42-fix-the-bug");
  });
});

describe("authedRepoUrl", () => {
  it("embeds encoded credentials", () => {
    const url = authedRepoUrl("https://gitlab.example.com", "group/repo", "claude-bot", "tok");
    expect(url).toBe("https://claude-bot:tok@gitlab.example.com/group/repo.git");
  });
  it("url-encodes special characters in the token", () => {
    const url = authedRepoUrl("https://gitlab.example.com", "g/r", "bot", "a@b/c");
    expect(url).toContain("a%40b%2Fc");
    expect(url.endsWith("/g/r.git")).toBe(true);
  });
  it("handles trailing slash on the base url", () => {
    const url = authedRepoUrl("https://gitlab.example.com/", "g/r", "bot", "t");
    expect(url).toBe("https://bot:t@gitlab.example.com/g/r.git");
  });
});

describe("safeName", () => {
  it("replaces path separators", () => {
    expect(safeName("group/sub/repo")).toBe("group__sub__repo");
  });
});
