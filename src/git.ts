import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "./log";

const execFileAsync = promisify(execFile);

/** Build a slug suitable for a git branch segment. */
export function slugify(input: string, maxLen = 40): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return slug || "issue";
}

/** Branch name for a given issue. */
export function branchName(issueIid: number, title: string): string {
  return `claude/issue-${issueIid}-${slugify(title)}`;
}

/**
 * Build an HTTPS clone URL with embedded bot credentials.
 * e.g. https://claude-bot:TOKEN@gitlab.example.com/group/repo.git
 */
export function authedRepoUrl(
  baseUrl: string,
  projectPath: string,
  username: string,
  token: string,
): string {
  const u = new URL(baseUrl);
  u.username = encodeURIComponent(username);
  u.password = encodeURIComponent(token);
  const host = u.toString().replace(/\/+$/, "");
  return `${host}/${projectPath}.git`;
}

/** A filesystem-safe directory name for a project. */
export function safeName(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9._-]+/g, "__");
}

export interface WorktreeHandle {
  dir: string;
  branch: string;
  cleanup: () => Promise<void>;
}

interface GitOpsOptions {
  workspacesDir: string;
  botUsername: string;
  botEmail: string;
  logger: Logger;
}

export class GitOps {
  private readonly workspacesDir: string;
  private readonly botUsername: string;
  private readonly botEmail: string;
  private readonly logger: Logger;

  constructor(opts: GitOpsOptions) {
    this.workspacesDir = opts.workspacesDir;
    this.botUsername = opts.botUsername;
    this.botEmail = opts.botEmail;
    this.logger = opts.logger;
  }

  private async git(args: string[], cwd?: string): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0", // never hang waiting for credentials
      },
    });
    return stdout.trim();
  }

  private mirrorDir(projectPath: string): string {
    return join(this.workspacesDir, safeName(projectPath), ".git-mirror");
  }

  /** Ensure a bare mirror exists and is up to date. */
  async ensureMirror(repoUrl: string, projectPath: string): Promise<string> {
    const dir = this.mirrorDir(projectPath);
    const exists = await fs
      .stat(dir)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      await fs.mkdir(join(this.workspacesDir, safeName(projectPath)), { recursive: true });
      await this.git(["clone", "--mirror", repoUrl, dir]);
    } else {
      // Refresh remote URL (token may have rotated) and fetch.
      await this.git(["remote", "set-url", "origin", repoUrl], dir);
      await this.git(["fetch", "--prune", "origin"], dir);
    }
    return dir;
  }

  /**
   * Create an isolated worktree off `baseBranch` on a new branch.
   * Caller must invoke the returned `cleanup()` when done.
   */
  async createWorktree(
    projectPath: string,
    baseBranch: string,
    branch: string,
  ): Promise<WorktreeHandle> {
    const mirror = this.mirrorDir(projectPath);
    const dir = join(
      this.workspacesDir,
      safeName(projectPath),
      "wt",
      branch.replace(/[^a-zA-Z0-9._-]+/g, "_"),
    );
    // Clean any stale worktree at that path.
    await this.removeWorktreeAt(mirror, dir).catch(() => undefined);
    await this.git(
      ["worktree", "add", "-b", branch, dir, `origin/${baseBranch}`],
      mirror,
    );
    // Set commit identity local to the worktree.
    await this.git(["config", "user.name", this.botUsername], dir);
    await this.git(["config", "user.email", this.botEmail], dir);

    return {
      dir,
      branch,
      cleanup: () => this.removeWorktreeAt(mirror, dir),
    };
  }

  private async removeWorktreeAt(mirror: string, dir: string): Promise<void> {
    await this.git(["worktree", "remove", "--force", dir], mirror).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await this.git(["worktree", "prune"], mirror).catch(() => undefined);
  }

  /** Whether the worktree has uncommitted changes. */
  async hasChanges(worktreeDir: string): Promise<boolean> {
    const status = await this.git(["status", "--porcelain"], worktreeDir);
    return status.length > 0;
  }

  /** Stage everything, commit with the given message. */
  async commitAll(worktreeDir: string, message: string): Promise<void> {
    await this.git(["add", "-A"], worktreeDir);
    await this.git(["commit", "-m", message], worktreeDir);
  }

  /** Push the branch to origin. */
  async push(worktreeDir: string, branch: string): Promise<void> {
    await this.git(["push", "-u", "origin", `${branch}:${branch}`], worktreeDir);
  }
}
