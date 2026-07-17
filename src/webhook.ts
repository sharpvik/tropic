/**
 * Parsing and filtering of GitLab Issue Hook payloads.
 *
 * We only act on a *transition* where the Claude bot becomes newly assigned to an
 * issue — not on every edit of an issue that already has the bot assigned.
 */

export interface IssueJobPayload {
  projectId: number;
  issueIid: number;
  title: string;
  description: string;
  /** Full project path, e.g. "group/repo" — used for git + API. */
  projectPath: string;
  /** Stable key for dedupe across webhook retries / rapid re-assign. */
  dedupeKey: string;
}

interface Assignee {
  username?: string;
}

interface IssueHook {
  object_kind?: string;
  event_type?: string;
  object_attributes?: {
    iid?: number;
    action?: string;
    title?: string;
    description?: string;
  };
  project?: {
    id?: number;
    path_with_namespace?: string;
  };
  assignees?: Assignee[];
  changes?: {
    assignees?: {
      previous?: Assignee[];
      current?: Assignee[];
    };
  };
}

function hasUser(list: Assignee[] | undefined, username: string): boolean {
  return (list ?? []).some((a) => a.username === username);
}

/**
 * Returns a job payload when the hook represents the Claude bot being *newly*
 * assigned to an issue; otherwise `null`.
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

  // Must be a change to assignees (an update event carrying an assignee delta).
  const change = hook.changes?.assignees;
  if (!change) return null;

  const nowAssigned = hasUser(change.current, botUsername);
  const wasAssigned = hasUser(change.previous, botUsername);

  // Fire only on the false -> true transition.
  if (!nowAssigned || wasAssigned) return null;

  return {
    projectId: project.id,
    issueIid: attrs.iid,
    title: attrs.title ?? `Issue #${attrs.iid}`,
    description: attrs.description ?? "",
    projectPath: project.path_with_namespace,
    dedupeKey: `${project.id}:${attrs.iid}:assigned`,
  };
}
