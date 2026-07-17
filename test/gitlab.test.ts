import { describe, it, expect, vi } from "vitest";
import { GitLabClient, type GitLabApi } from "../src/gitlab";
import pino from "pino";

const logger = pino({ level: "silent" });

function fakeApi(overrides: Partial<GitLabApi> = {}): GitLabApi {
  return {
    Users: { showCurrentUser: vi.fn(async () => ({ id: 1, username: "claude-bot" })) },
    Projects: { show: vi.fn(async () => ({ default_branch: "main" })) },
    IssueNotes: { create: vi.fn(async () => ({})) },
    MergeRequests: { create: vi.fn(async () => ({ iid: 3, web_url: "https://mr/3" })) },
    ...overrides,
  } as GitLabApi;
}

function client(api: GitLabApi) {
  return new GitLabClient({ baseUrl: "https://gitlab.example.com/", token: "tok", logger, api });
}

describe("GitLabClient (gitbeaker-backed)", () => {
  it("returns the current user", async () => {
    const api = fakeApi();
    const user = await client(api).currentUser();
    expect(user).toEqual({ id: 1, username: "claude-bot" });
    expect(api.Users.showCurrentUser).toHaveBeenCalled();
  });

  it("reads the default branch via Projects.show", async () => {
    const api = fakeApi({ Projects: { show: vi.fn(async () => ({ default_branch: "develop" })) } });
    expect(await client(api).defaultBranch(7)).toBe("develop");
    expect(api.Projects.show).toHaveBeenCalledWith(7);
  });

  it("comments on an issue with the right args", async () => {
    const api = fakeApi();
    await client(api).commentOnIssue(7, 42, "hello");
    expect(api.IssueNotes.create).toHaveBeenCalledWith(7, 42, "hello");
  });

  it("creates a merge request mapping params to the SDK signature", async () => {
    const api = fakeApi();
    const mr = await client(api).createMergeRequest(7, {
      sourceBranch: "claude/x",
      targetBranch: "main",
      title: "T",
      description: "D",
    });
    expect(mr).toEqual({ iid: 3, web_url: "https://mr/3" });
    expect(api.MergeRequests.create).toHaveBeenCalledWith(7, "claude/x", "main", "T", {
      description: "D",
      removeSourceBranch: true,
    });
  });

  it("propagates SDK errors", async () => {
    const api = fakeApi({
      Users: {
        showCurrentUser: vi.fn(async () => {
          throw new Error("403 Forbidden");
        }),
      },
    });
    await expect(client(api).currentUser()).rejects.toThrow(/403/);
  });
});
