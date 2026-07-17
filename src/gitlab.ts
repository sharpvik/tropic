import { Gitlab } from "@gitbeaker/rest";
import type { Logger } from "./log";

export interface MergeRequest {
  iid: number;
  web_url: string;
}

export interface GitLabUser {
  id: number;
  username: string;
}

/**
 * The subset of the gitbeaker API surface this service uses. Declaring it as an
 * interface lets tests inject a lightweight fake without a live GitLab.
 */
export interface GitLabApi {
  Users: { showCurrentUser(): Promise<{ id: number; username: string }> };
  Projects: { show(projectId: number): Promise<{ default_branch: string }> };
  IssueNotes: {
    create(projectId: number, issueIid: number, body: string): Promise<unknown>;
  };
  MergeRequests: {
    create(
      projectId: number,
      sourceBranch: string,
      targetBranch: string,
      title: string,
      options?: { description?: string; removeSourceBranch?: boolean },
    ): Promise<{ iid: number; web_url: string }>;
  };
}

interface GitLabClientOptions {
  baseUrl: string;
  token: string;
  logger: Logger;
  /** Inject a pre-built API (tests); otherwise a gitbeaker client is created. */
  api?: GitLabApi;
}

/**
 * Thin wrapper over gitbeaker exposing only what the worker needs, with our own
 * return shapes so callers don't depend on the SDK's types directly.
 */
export class GitLabClient {
  private readonly api: GitLabApi;

  constructor(opts: GitLabClientOptions) {
    this.api =
      opts.api ??
      (new Gitlab({
        host: opts.baseUrl.replace(/\/+$/, ""),
        token: opts.token,
      }) as unknown as GitLabApi);
  }

  /** The authenticated user — used by the install self-test to validate the token. */
  async currentUser(): Promise<GitLabUser> {
    const u = await this.api.Users.showCurrentUser();
    return { id: u.id, username: u.username };
  }

  /** Default branch of a project (target for MRs). */
  async defaultBranch(projectId: number): Promise<string> {
    const project = await this.api.Projects.show(projectId);
    return project.default_branch;
  }

  async commentOnIssue(projectId: number, issueIid: number, body: string): Promise<void> {
    await this.api.IssueNotes.create(projectId, issueIid, body);
  }

  async createMergeRequest(
    projectId: number,
    params: {
      sourceBranch: string;
      targetBranch: string;
      title: string;
      description: string;
      removeSourceBranch?: boolean;
    },
  ): Promise<MergeRequest> {
    const mr = await this.api.MergeRequests.create(
      projectId,
      params.sourceBranch,
      params.targetBranch,
      params.title,
      {
        description: params.description,
        removeSourceBranch: params.removeSourceBranch ?? true,
      },
    );
    return { iid: mr.iid, web_url: mr.web_url };
  }
}
