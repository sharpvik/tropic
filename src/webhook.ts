/**
 * Parsing and filtering of GitLab webhook payloads.
 *
 * Two triggers:
 *  - Issue Hook: the Claude bot is newly assigned to an issue        → issue job
 *  - Note Hook:  someone @-mentions the bot in an MR comment         → mr_comment job
 */

/** Common fields shared by every job. */
interface JobCommon {
  projectId: number;
  /** Full project path, e.g. "group/repo" — used for git + API. */
  projectPath: string;
  /** Stable key for dedupe across webhook retries. */
  dedupeKey: string;
}

/** An issue was assigned to the bot → implement it on a new branch, open an MR. */
export interface IssueJobPayload extends JobCommon {
  kind: "issue";
  issueIid: number;
  title: string;
  description: string;
}

/** The bot was @-mentioned in an MR comment → iterate on that MR's branch. */
export interface MrCommentJobPayload extends JobCommon {
  kind: "mr_comment";
  mrIid: number;
  sourceBranch: string;
  title: string;
  /** The comment text that mentioned the bot. */
  comment: string;
}

export type JobPayload = IssueJobPayload | MrCommentJobPayload;

interface Assignee {
  username?: string;
}

interface IssueHook {
  object_kind?: string;
  object_attributes?: {
    iid?: number;
    action?: string;
    title?: string;
    description?: string;
  };
  project?: { id?: number; path_with_namespace?: string };
  assignees?: Assignee[];
  changes?: { assignees?: { previous?: Assignee[]; current?: Assignee[] } };
}

interface NoteHook {
  object_kind?: string;
  user?: { username?: string };
  project?: { id?: number; path_with_namespace?: string };
  object_attributes?: {
    id?: number;
    note?: string;
    noteable_type?: string;
  };
  merge_request?: {
    iid?: number;
    source_branch?: string;
    title?: string;
  };
}

function hasUser(list: Assignee[] | undefined, username: string): boolean {
  return (list ?? []).some((a) => a.username === username);
}

/** True if the text @-mentions the given username (e.g. "@claude-bot"). */
export function mentionsUser(text: string | undefined, username: string): boolean {
  if (!text) return false;
  // Word-boundary-ish match so "@claude-bot" matches but "@claude-bottom" doesn't.
  const re = new RegExp(`(^|[^\\w@])@${escapeRegExp(username)}(?![\\w-])`);
  return re.test(text);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns an issue job when the hook represents the bot being *newly* assigned to
 * an issue (or an issue created already assigned to it); otherwise `null`.
 */
export function parseAssignmentHook(
  body: unknown,
  botUsername: string,
): IssueJobPayload | null {
  if (!body || typeof body !== "object") return null;
  const hook = body as IssueHook;
  if (hook.object_kind !== "issue") return null;

  const attrs = hook.object_attributes;
  const project = hook.project;
  if (!attrs?.iid || !project?.id || !project.path_with_namespace) return null;

  const job: IssueJobPayload = {
    kind: "issue",
    projectId: project.id,
    issueIid: attrs.iid,
    title: attrs.title ?? `Issue #${attrs.iid}`,
    description: attrs.description ?? "",
    projectPath: project.path_with_namespace,
    dedupeKey: `${project.id}:issue:${attrs.iid}:assigned`,
  };

  // Issue created already assigned to the bot (no assignee transition on "open").
  if (attrs.action === "open") {
    return hasUser(hook.assignees, botUsername) ? job : null;
  }

  // Existing issue updated — fire only on the false -> true assignment transition.
  const change = hook.changes?.assignees;
  if (!change) return null;
  const nowAssigned = hasUser(change.current, botUsername);
  const wasAssigned = hasUser(change.previous, botUsername);
  if (!nowAssigned || wasAssigned) return null;

  return job;
}

/**
 * Returns an mr_comment job when the hook is a note that @-mentions the bot on a
 * merge request (and was NOT written by the bot itself); otherwise `null`.
 */
export function parseNoteHook(
  body: unknown,
  botUsername: string,
): MrCommentJobPayload | null {
  if (!body || typeof body !== "object") return null;
  const hook = body as NoteHook;
  if (hook.object_kind !== "note") return null;

  const attrs = hook.object_attributes;
  const project = hook.project;
  const mr = hook.merge_request;
  if (!attrs?.id || !project?.id || !project.path_with_namespace) return null;

  // Only MR comments; only when the bot is mentioned.
  if (attrs.noteable_type !== "MergeRequest") return null;
  if (!mr?.iid || !mr.source_branch) return null;
  if (!mentionsUser(attrs.note, botUsername)) return null;

  // Never react to the bot's own comments (avoids feedback loops).
  if (hook.user?.username === botUsername) return null;

  return {
    kind: "mr_comment",
    projectId: project.id,
    projectPath: project.path_with_namespace,
    mrIid: mr.iid,
    sourceBranch: mr.source_branch,
    title: mr.title ?? `MR !${mr.iid}`,
    comment: attrs.note ?? "",
    // Note id makes this unique per comment, so webhook retries dedupe but each new
    // comment is a fresh job.
    dedupeKey: `${project.id}:mr:${mr.iid}:note:${attrs.id}`,
  };
}
