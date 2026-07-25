// Human-readable formatting of Planfix responses.
// Every renderer is tolerant: when the response shape is unknown it falls back
// to raw JSON, so nothing is lost and no structure is invented.

type Json = Record<string, unknown>;

function obj(v: unknown): Json | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
}

function val(v: unknown): string | undefined {
  if (typeof v === "string") return v.length ? v : undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/** Render a reference object `{id, name}` → "Name (#id)". */
function ref(v: unknown): string | undefined {
  const o = obj(v);
  if (!o) return val(v);
  const n = val(o.name);
  const id = val(o.id);
  if (n && id) return `${n} (#${id})`;
  return n ?? (id ? `#${id}` : undefined);
}

/** A Planfix date/time may be a string or a `{date,time,datetime}` object. */
function dateStr(v: unknown): string | undefined {
  const o = obj(v);
  if (o) return val(o.datetime) ?? val(o.date) ?? undefined;
  return val(v);
}

/** Assignee names from `assignees:{users:[{id,name}]}` or a plain array. */
function peopleNames(v: unknown): string | undefined {
  const o = obj(v);
  const users = o && Array.isArray(o.users) ? (o.users as unknown[]) : Array.isArray(v) ? (v as unknown[]) : [];
  const names = users.map(ref).filter((s): s is string => Boolean(s));
  return names.length ? names.join(", ") : undefined;
}

export function jsonFallback(resp: unknown): string {
  return JSON.stringify(resp, null, 2);
}

/** Find the entity array in a response: preferred keys first, then the first array found. */
export function findArray(resp: unknown, keys: string[]): unknown[] | undefined {
  const o = obj(resp);
  if (!o) return undefined;
  for (const k of keys) if (Array.isArray(o[k])) return o[k] as unknown[];
  for (const v of Object.values(o)) if (Array.isArray(v)) return v as unknown[];
  return undefined;
}

function line(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(" | ");
}

/**
 * Paged list rendering with exact pagination metadata. `resp` may hold up to
 * `pageSize + 1` items (over-fetch, see src/paging.ts) — the extra row is
 * sliced off and never rendered. `hasMore` is computed by the caller; the
 * footer names the tool to call for the next page.
 */
function renderPagedList(
  label: string,
  tool: string,
  resp: unknown,
  keys: string[],
  render: (item: Json, index: number) => string,
  pageSize: number,
  offset: number,
  hasMore: boolean,
): string {
  const items = findArray(resp, keys);
  if (!items) return jsonFallback(resp);
  const shown = items.length > pageSize ? items.slice(0, pageSize) : items;
  if (shown.length === 0) return `${label}: nothing found. has_more: false`;
  const body = shown.map((it, i) => `${offset + i + 1}. ${render(obj(it) ?? {}, i)}`).join("\n");
  const footer = hasMore
    ? `has_more: true — next page: ${tool} with offset: ${offset + pageSize}.`
    : "has_more: false";
  return `${label} (${shown.length}${hasMore ? "+" : ""}):\n${body}\n${footer}`;
}

// ── Tasks ───────────────────────────────────────────────────────────────────

export function formatTask(t: Json): string {
  return line([
    `#${val(t.id) ?? "?"}`,
    val(t.name),
    ref(t.status) && `status: ${ref(t.status)}`,
    (val(t.priority) ?? ref(t.priority)) && `priority: ${val(t.priority) ?? ref(t.priority)}`,
    peopleNames(t.assignees) && `assignees: ${peopleNames(t.assignees)}`,
    ref(t.project) && `project: ${ref(t.project)}`,
    dateStr(t.endDateTime) && `deadline: ${dateStr(t.endDateTime)}`,
  ]);
}

/** Identifier-grade task row for response_format: "CONCISE". */
function conciseTaskRow(t: Json): string {
  return line([`#${val(t.id) ?? "?"}`, val(t.name), ref(t.status) && `status: ${ref(t.status)}`]);
}

export function formatTaskList(resp: unknown, pageSize: number, offset: number, hasMore: boolean, concise = false): string {
  return renderPagedList("Tasks", "get_tasks", resp, ["tasks"], (t) => (concise ? conciseTaskRow(t) : formatTask(t)), pageSize, offset, hasMore);
}

export function formatSingleTask(resp: unknown, concise = false): string {
  const t = obj(obj(resp)?.task) ?? obj(resp);
  if (!t) return jsonFallback(resp);
  if (concise) return conciseTaskRow(t);
  const desc = val(t.description);
  return [
    formatTask(t),
    desc ? `\nDescription:\n${desc}` : "",
  ].join("");
}

// ── Contacts ──────────────────────────────────────────────────────────────────

function phones(v: unknown): string | undefined {
  if (Array.isArray(v)) {
    const ph = v.map((p) => val(obj(p)?.number) ?? val(p)).filter(Boolean);
    return ph.length ? ph.join(", ") : undefined;
  }
  return val(v);
}

export function formatContact(c: Json): string {
  return line([
    `#${val(c.id) ?? "?"}`,
    val(c.name) ?? line([val(c.lastname), val(c.firstname)]) ?? undefined,
    val(c.email) && `email: ${val(c.email)}`,
    phones(c.phones) && `phone: ${phones(c.phones)}`,
    ref(c.company) && `company: ${ref(c.company)}`,
  ]);
}

/** Identifier-grade contact row for response_format: "CONCISE". */
function conciseContactRow(c: Json): string {
  return line([`#${val(c.id) ?? "?"}`, val(c.name) ?? line([val(c.lastname), val(c.firstname)]) ?? undefined]);
}

export function formatContactList(resp: unknown, pageSize: number, offset: number, hasMore: boolean, concise = false): string {
  return renderPagedList("Contacts", "get_contacts", resp, ["contacts"], (c) => (concise ? conciseContactRow(c) : formatContact(c)), pageSize, offset, hasMore);
}

export function formatSingleContact(resp: unknown): string {
  const c = obj(obj(resp)?.contact) ?? obj(resp);
  return c ? formatContact(c) : jsonFallback(resp);
}

// ── Projects ──────────────────────────────────────────────────────────────────

/**
 * The three fixed system project statuses. The REST API returns project
 * `status` as a bare `{id}` — no name, and no endpoint lists project statuses
 * (docs/spikes/projects.md). Mapping evidence: 2 = Active proven live;
 * 0 = Draft / 1 = Completed confirmed by the operator against the UI
 * (2026-07-26, project 7854 displays as Completed in the UI).
 */
export const PROJECT_STATUS_LABELS: Record<number, string> = {
  0: "Draft",
  1: "Completed",
  2: "Active",
};

function projectStatusLabel(v: unknown): string | undefined {
  const id = Number(val(obj(v)?.id) ?? val(v));
  if (Number.isFinite(id) && PROJECT_STATUS_LABELS[id] !== undefined) return PROJECT_STATUS_LABELS[id];
  return ref(v);
}

export function formatProject(p: Json): string {
  return line([
    `#${val(p.id) ?? "?"}`,
    val(p.name),
    projectStatusLabel(p.status) && `status: ${projectStatusLabel(p.status)}`,
    ref(p.owner) && `owner: ${ref(p.owner)}`,
    ref(p.group) && `group: ${ref(p.group)}`,
    ref(p.parent) && `parent: ${ref(p.parent)}`,
    ref(p.counterparty) && `counterparty: ${ref(p.counterparty)}`,
    ref(p.template) && `template: ${ref(p.template)}`,
    dateStr(p.startDate) && `start: ${dateStr(p.startDate)}`,
    dateStr(p.endDate) && `end: ${dateStr(p.endDate)}`,
    p.overdue === true ? "OVERDUE" : undefined,
    p.isDeleted === true ? "DELETED" : undefined,
  ]);
}

export function formatProjectList(resp: unknown, pageSize: number, offset: number, hasMore: boolean): string {
  return renderPagedList("Projects", "get_projects", resp, ["projects"], (p) => formatProject(p), pageSize, offset, hasMore);
}

export function formatSingleProject(resp: unknown): string {
  const p = obj(obj(resp)?.project) ?? obj(resp);
  if (!p) return jsonFallback(resp);
  const desc = val(p.description);
  return [formatProject(p), desc ? `\nDescription:\n${desc}` : ""].join("");
}

/**
 * Compact project rows with exact pagination metadata for search_projects.
 * `resp` may hold up to `pageSize + 1` projects (over-fetch, see src/paging.ts).
 */
export function formatProjectSearchList(resp: unknown, pageSize: number, offset: number, hasMore: boolean): string {
  const items = findArray(resp, ["projects"]);
  if (!items) return jsonFallback(resp);
  const shown = items.length > pageSize ? items.slice(0, pageSize) : items;
  if (shown.length === 0) {
    return "No projects matched the given filters. has_more: false. " +
      "Try relaxing the filters (e.g. shorten nameContains or drop activeOnly).";
  }
  const body = shown.map((it, i) => `${offset + i + 1}. ${formatProject(obj(it) ?? {})}`).join("\n");
  const footer = hasMore
    ? `has_more: true — next page: search_projects with the same filters and offset: ${offset + pageSize}.`
    : "has_more: false";
  return `Projects (${shown.length}${hasMore ? "+" : ""}):\n${body}\n${footer}`;
}

/** Description cap for the overview card — the full text stays one get_project away. */
const OVERVIEW_DESCRIPTION_CAP = 500;

/**
 * Project state card for get_project_overview: project fields with a
 * human-readable status, task counts by status (scan-capped — counts become
 * explicit lower bounds when the cap is hit), and a recency signal with a
 * small list of the most recently updated tasks. All caps are explicit in the
 * output; nothing truncates silently.
 */
export function formatProjectOverview(a: {
  projectResp: unknown;
  scanned: number;
  scanCapped: boolean;
  activeCount: number;
  closedCount: number;
  byStatus: Array<[string, number]>;
  recentDays: number;
  recentCount: number;
  recentCapped: boolean;
  recentTasks: unknown[];
  recentLimit: number;
}): string {
  const p = obj(obj(a.projectResp)?.project) ?? obj(a.projectResp);
  const parts: string[] = [];

  if (!p) {
    parts.push(jsonFallback(a.projectResp));
  } else {
    parts.push(formatProject(p));
    const desc = val(p.description);
    if (desc) {
      const cut = desc.length > OVERVIEW_DESCRIPTION_CAP
        ? `${desc.slice(0, OVERVIEW_DESCRIPTION_CAP)}… [truncated — full text via get_project]`
        : desc;
      parts.push(`Description:\n${cut}`);
    }
  }

  const n = (count: number) => `${count}${a.scanCapped ? "+" : ""}`;
  const capNote = a.scanCapped
    ? " (scan cap reached — counts are lower bounds; use search_tasks with projectId and statusId for exact slices)"
    : "";
  parts.push(`Tasks: ${n(a.scanned)} scanned${capNote} — active: ${a.activeCount}, closed: ${a.closedCount}.`);
  if (a.byStatus.length > 0) {
    parts.push(`By status: ${a.byStatus.map(([name, count]) => `${name}: ${count}`).join(", ")}`);
  }

  const recentN = `${a.recentCount}${a.recentCapped ? "+" : ""}`;
  if (a.recentCount === 0) {
    parts.push(`Activity: no tasks changed or commented in the last ${a.recentDays} days — the project looks inactive.`);
  } else {
    const rows = a.recentTasks.slice(0, a.recentLimit).map((it, i) => {
      const t = obj(it) ?? {};
      return `${i + 1}. ${line([
        `#${val(t.id) ?? "?"}`,
        val(t.name),
        ref(t.status) && `status: ${ref(t.status)}`,
        dateStr(t.dateOfLastUpdate) && `updated: ${dateStr(t.dateOfLastUpdate)}`,
      ])}`;
    });
    const latest = obj(a.recentTasks[0]);
    const latestDate = latest ? dateStr(latest.dateOfLastUpdate) : undefined;
    parts.push(
      `Activity: ${recentN} tasks changed or commented in the last ${a.recentDays} days` +
      `${latestDate ? ` (most recent: ${latestDate})` : ""}.`,
    );
    parts.push(`Recently updated (${rows.length} of ${recentN}):\n${rows.join("\n")}`);
  }

  return parts.join("\n\n");
}

// ── Users ─────────────────────────────────────────────────────────────────────

export function formatUser(u: Json): string {
  return line([
    `#${val(u.id) ?? "?"}`,
    val(u.name) ?? line([val(u.lastname), val(u.firstname), val(u.midname)]),
    val(u.email) && `email: ${val(u.email)}`,
    ref(u.position) && `position: ${ref(u.position)}`,
  ]);
}

export function formatUserList(resp: unknown, pageSize: number, offset: number, hasMore: boolean): string {
  return renderPagedList("Employees", "list_users", resp, ["users"], (u) => formatUser(u), pageSize, offset, hasMore);
}

export function formatSingleUser(resp: unknown): string {
  const u = obj(obj(resp)?.user) ?? obj(resp);
  return u ? formatUser(u) : jsonFallback(resp);
}

// ── Comments ────────────────────────────────────────────────────────────────────

function commentRow(c: Json, concise = false): string {
  return line([
    `#${val(c.id) ?? "?"}`,
    ref(c.owner) && `author: ${ref(c.owner)}`,
    dateStr(c.dateTime) && dateStr(c.dateTime),
    concise ? undefined : val(c.description),
  ]);
}

export function formatCommentList(resp: unknown, pageSize: number, offset: number, hasMore: boolean): string {
  return renderPagedList("Comments", "get_comments", resp, ["comments"], (c) => commentRow(c), pageSize, offset, hasMore);
}

// ── Composite: task + comments (get_task_full) ────────────────────────────────

/**
 * Renders a task card followed by its comments. `commentsResp` may hold up to
 * `limit + 1` comments (over-fetch, see src/paging.ts) — the extra row is
 * sliced off; `hasMore` is computed by the caller and exact.
 */
export function formatTaskFull(
  taskResp: unknown,
  commentsResp: unknown,
  opts: { taskId: number; limit: number; hasMore: boolean; concise?: boolean },
): string {
  const head = formatSingleTask(taskResp, opts.concise);
  const items = findArray(commentsResp, ["comments"]);
  if (!items) return `${head}\n\n${jsonFallback(commentsResp)}`;
  const hasMore = opts.hasMore;
  const shown = items.length > opts.limit ? items.slice(0, opts.limit) : items;
  if (shown.length === 0) return `${head}\n\nComments: none.\nhas_more: false`;
  const body = shown.map((it, i) => `${i + 1}. ${commentRow(obj(it) ?? {}, opts.concise)}`).join("\n");
  const footer = hasMore
    ? `has_more: true — fetch the remaining comments with get_comments (taskId: ${opts.taskId}, offset: ${opts.limit}).`
    : "has_more: false";
  return `${head}\n\nComments (${shown.length}${hasMore ? "+" : ""}):\n${body}\n${footer}`;
}

// ── Task search (search_tasks) ────────────────────────────────────────────────

function taskSearchRow(t: Json): string {
  return line([
    `#${val(t.id) ?? "?"}`,
    val(t.name),
    ref(t.status) && `status: ${ref(t.status)}`,
    peopleNames(t.assignees) && `assignees: ${peopleNames(t.assignees)}`,
    ref(t.project) && `project: ${ref(t.project)}`,
  ]);
}

/**
 * Compact task rows with exact pagination metadata. `resp` may hold up to
 * `pageSize + 1` tasks (over-fetch, see src/paging.ts) — the extra row is
 * sliced off; `hasMore` is computed by the caller and exact. `opts` retargets
 * the footer/empty texts for other task-list-shaped tools (get_task_children).
 */
export function formatTaskSearchList(
  resp: unknown,
  pageSize: number,
  offset: number,
  hasMore: boolean,
  opts?: { tool?: string; emptyText?: string; concise?: boolean },
): string {
  const tool = opts?.tool ?? "search_tasks";
  const items = findArray(resp, ["tasks"]);
  if (!items) return jsonFallback(resp);
  const shown = items.length > pageSize ? items.slice(0, pageSize) : items;
  if (shown.length === 0) {
    return opts?.emptyText
      ?? "No tasks matched the given filters. has_more: false. Try relaxing the filters (e.g. drop updatedSince or shorten nameContains).";
  }
  const row = opts?.concise ? conciseTaskRow : taskSearchRow;
  const body = shown.map((it, i) => `${offset + i + 1}. ${row(obj(it) ?? {})}`).join("\n");
  const footer = hasMore
    ? `has_more: true — next page: ${tool} with the same filters and offset: ${offset + pageSize}.`
    : "has_more: false";
  return `Tasks (${shown.length}${hasMore ? "+" : ""}):\n${body}\n${footer}`;
}

// ── Time entries (get_task_time_entries) ─────────────────────────────────────

/** Pick a custom field's {value, stringValue} off a data tag entry by field id. */
function cfValue(e: Json, fieldId: number): { value?: unknown; str?: string } {
  const data = Array.isArray(e.customFieldData) ? (e.customFieldData as unknown[]) : [];
  for (const item of data) {
    const o = obj(item);
    if (obj(o?.field)?.id === fieldId) return { value: o?.value, str: val(o?.stringValue) };
  }
  return {};
}

function durationHM(sec: unknown): string | undefined {
  if (typeof sec !== "number" || sec <= 0) return undefined;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Compact time-entry rows with exact pagination metadata. `resp` is expected to
 * hold up to `pageSize + 1` entries (the caller over-fetches one row). Field
 * ids are passed in by the caller (they are data-tag-specific).
 */
export function formatTimeEntryList(
  resp: unknown,
  pageSize: number,
  offset: number,
  f: { date: number; time: number; user: number; type: number; comment: number },
): string {
  const items = findArray(resp, ["dataTagEntries", "entries"]);
  if (!items) return jsonFallback(resp);
  const hasMore = items.length > pageSize;
  const shown = hasMore ? items.slice(0, pageSize) : items;
  if (shown.length === 0) return "No time entries found on this task. has_more: false";
  const body = shown
    .map((it, i) => {
      const e = obj(it) ?? {};
      const time = cfValue(e, f.time);
      const dur = durationHM(obj(time.value)?.durationSec);
      return `${offset + i + 1}. ${line([
        `#${val(e.key) ?? "?"}`,
        cfValue(e, f.date).str,
        time.str && `${time.str}${dur ? ` (${dur})` : ""}`,
        cfValue(e, f.user).str,
        cfValue(e, f.type).str,
        cfValue(e, f.comment).str,
        val(e.commentId) && `commentId: ${val(e.commentId)}`,
      ])}`;
    })
    .join("\n");
  const footer = hasMore
    ? `has_more: true — next page: get_task_time_entries with offset: ${offset + pageSize}.`
    : "has_more: false";
  return `Time entries (${shown.length}${hasMore ? "+" : ""}):\n${body}\n${footer}`;
}

// ── Checklists (get_task_checklist) ───────────────────────────────────────────

/**
 * Checklist rows `#id | name | [x]/[ ]` (+ assignees when present) with exact
 * pagination metadata; `resp` may hold up to `pageSize + 1` items (over-fetch,
 * see src/paging.ts).
 */
export function formatChecklist(resp: unknown, pageSize: number, offset: number, hasMore: boolean, taskId: number): string {
  const items = findArray(resp, ["items"]);
  if (!items) return jsonFallback(resp);
  const shown = items.length > pageSize ? items.slice(0, pageSize) : items;
  if (shown.length === 0) return `Task ${taskId} has no checklist items. has_more: false`;
  const body = shown
    .map((it, i) => {
      const e = obj(it) ?? {};
      return `${offset + i + 1}. ${line([
        `#${val(e.id) ?? "?"}`,
        val(e.name),
        e.isDone === true ? "[x]" : "[ ]",
        peopleNames(e.assignees) && `assignees: ${peopleNames(e.assignees)}`,
      ])}`;
    })
    .join("\n");
  const footer = hasMore
    ? `has_more: true — next page: get_task_checklist with offset: ${offset + pageSize}.`
    : "has_more: false";
  return `Checklist (${shown.length}${hasMore ? "+" : ""}):\n${body}\n${footer}`;
}

// ── Directories / custom fields / datatags ───────────────────────────────────────

export function formatDirectoryList(resp: unknown, pageSize: number, offset: number, hasMore: boolean): string {
  return renderPagedList("Directories", "list_directories", resp, ["directories"], (d) =>
    line([`#${val(d.id) ?? "?"}`, val(d.name)]), pageSize, offset, hasMore);
}

export function formatDirectoryEntryList(resp: unknown, pageSize: number, offset: number, hasMore: boolean): string {
  return renderPagedList("Directory entries", "list_directory_entries", resp, ["directoryEntries", "entries"], (e) =>
    line([`#${val(e.key) ?? val(e.id) ?? "?"}`, val(e.name)]), pageSize, offset, hasMore);
}

export function formatCustomFieldList(resp: unknown, pageSize: number, offset: number, hasMore: boolean): string {
  return renderPagedList("Custom fields", "list_custom_fields", resp, ["customFields", "customfields", "fields"], (f) =>
    line([`#${val(f.id) ?? "?"}`, val(f.name), ref(f.type) && `type: ${ref(f.type)}`]), pageSize, offset, hasMore);
}

export function formatDatatagList(resp: unknown, pageSize: number, offset: number, hasMore: boolean): string {
  return renderPagedList("Data tags", "list_datatags", resp, ["dataTags", "datatags"], (d) =>
    line([`#${val(d.id) ?? "?"}`, val(d.name)]), pageSize, offset, hasMore);
}

export function formatFile(resp: unknown): string {
  const f = obj(obj(resp)?.file) ?? obj(resp);
  if (!f) return jsonFallback(resp);
  return line([`#${val(f.id) ?? "?"}`, val(f.name), val(f.size) && `size: ${val(f.size)}`]);
}

// ── Write acknowledgements ────────────────────────────────────────────────────────

/** Creation acknowledgement: Planfix responds `{result, id}`. */
export function formatCreated(label: string, resp: unknown): string {
  const id = val(obj(resp)?.id);
  return id ? `✓ ${label} created, ID: ${id}` : `✓ ${label} created.\n${jsonFallback(resp)}`;
}

/**
 * Update acknowledgement. Planfix responds with an empty body (200/202), so a
 * meaningful message is built from the id the caller passed in.
 */
export function formatUpdated(label: string, id: number | string): string {
  return `✓ ${label} #${id} updated.`;
}
