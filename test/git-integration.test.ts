import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitOps } from "../src/git";
import pino from "pino";

const execFileAsync = promisify(execFile);
const logger = pino({ level: "silent" });

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  return stdout.trim();
}

let root: string;
let remote: string; // bare repo acting as "origin"

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "gitops-"));
  remote = join(root, "remote.git");
  // Bare remote with a "main" branch carrying one commit.
  await git(["init", "--bare", "-b", "main", remote], root);
  const seed = join(root, "seed");
  await git(["clone", remote, seed], root);
  await fs.writeFile(join(seed, "README.md"), "hello\n");
  await git(["add", "-A"], seed);
  await git(["commit", "-m", "init"], seed);
  await git(["push", "origin", "main"], seed);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("GitOps mirror + worktree pipeline", () => {
  it("mirrors, creates a worktree off the default branch, commits, and pushes", async () => {
    const ops = new GitOps({
      workspacesDir: join(root, "ws"),
      botUsername: "claude-bot",
      botEmail: "claude-bot@example.com",
      logger,
    });

    await ops.ensureMirror(remote, "grp/proj");
    // This is the exact call that previously failed with "invalid reference: origin/main".
    const wt = await ops.createWorktree("grp/proj", "main", "claude/issue-1-x");

    expect(await ops.hasChanges(wt.dir)).toBe(false);

    await fs.writeFile(join(wt.dir, "NEW.md"), "content\n");
    expect(await ops.hasChanges(wt.dir)).toBe(true);

    await ops.commitAll(wt.dir, "add NEW.md\n\nCloses #1");
    await ops.push(wt.dir, "claude/issue-1-x");

    // The branch now exists on the remote.
    const refs = await git(["ls-remote", "--heads", remote, "claude/issue-1-x"], root);
    expect(refs).toContain("refs/heads/claude/issue-1-x");

    await wt.cleanup();
  });

  it("re-fetches an existing mirror without re-cloning", async () => {
    const ops = new GitOps({
      workspacesDir: join(root, "ws"),
      botUsername: "claude-bot",
      botEmail: "claude-bot@example.com",
      logger,
    });
    await ops.ensureMirror(remote, "grp/proj");
    // Second call should hit the fetch path and still yield a usable worktree.
    await ops.ensureMirror(remote, "grp/proj");
    const wt = await ops.createWorktree("grp/proj", "main", "claude/issue-2-y");
    expect(await fs.readFile(join(wt.dir, "README.md"), "utf8")).toContain("hello");
    await wt.cleanup();
  });
});
