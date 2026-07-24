// Человекочитаемое форматирование ответов Planfix.
// Все рендеры толерантны: если форма ответа неизвестна — отдают сырой JSON,
// чтобы ничего не потерять и не выдумывать структуру.

type Json = Record<string, unknown>;

function obj(v: unknown): Json | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
}

function val(v: unknown): string | undefined {
  if (typeof v === "string") return v.length ? v : undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/** Рендер ссылки-объекта `{id, name}` → "Имя (#id)". */
function ref(v: unknown): string | undefined {
  const o = obj(v);
  if (!o) return val(v);
  const n = val(o.name);
  const id = val(o.id);
  if (n && id) return `${n} (#${id})`;
  return n ?? (id ? `#${id}` : undefined);
}

/** Дата/время Planfix может быть строкой или объектом `{date,time,datetime}`. */
function dateStr(v: unknown): string | undefined {
  const o = obj(v);
  if (o) return val(o.datetime) ?? val(o.date) ?? undefined;
  return val(v);
}

/** Имена исполнителей из `assignees:{users:[{id,name}]}` или массива. */
function peopleNames(v: unknown): string | undefined {
  const o = obj(v);
  const users = o && Array.isArray(o.users) ? (o.users as unknown[]) : Array.isArray(v) ? (v as unknown[]) : [];
  const names = users.map(ref).filter((s): s is string => Boolean(s));
  return names.length ? names.join(", ") : undefined;
}

export function jsonFallback(resp: unknown): string {
  return JSON.stringify(resp, null, 2);
}

/** Найти массив сущностей в ответе: сначала по предпочтительным ключам, затем первый попавшийся. */
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
  if (shown.length === 0) return `${label}: ничего не найдено. has_more: false`;
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
    ref(t.status) && `статус: ${ref(t.status)}`,
    (val(t.priority) ?? ref(t.priority)) && `приоритет: ${val(t.priority) ?? ref(t.priority)}`,
    peopleNames(t.assignees) && `исполнители: ${peopleNames(t.assignees)}`,
    ref(t.project) && `проект: ${ref(t.project)}`,
    dateStr(t.endDateTime) && `дедлайн: ${dateStr(t.endDateTime)}`,
  ]);
}

/** Identifier-grade task row for response_format: "CONCISE". */
function conciseTaskRow(t: Json): string {
  return line([`#${val(t.id) ?? "?"}`, val(t.name), ref(t.status) && `статус: ${ref(t.status)}`]);
}

export function formatTaskList(resp: unknown, pageSize: number, offset: number, hasMore: boolean, concise = false): string {
  return renderPagedList("Задачи", "get_tasks", resp, ["tasks"], (t) => (concise ? conciseTaskRow(t) : formatTask(t)), pageSize, offset, hasMore);
}

export function formatSingleTask(resp: unknown, concise = false): string {
  const t = obj(obj(resp)?.task) ?? obj(resp);
  if (!t) return jsonFallback(resp);
  if (concise) return conciseTaskRow(t);
  const desc = val(t.description);
  return [
    formatTask(t),
    desc ? `\nОписание:\n${desc}` : "",
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
    phones(c.phones) && `тел: ${phones(c.phones)}`,
    ref(c.company) && `компания: ${ref(c.company)}`,
  ]);
}

/** Identifier-grade contact row for response_format: "CONCISE". */
function conciseContactRow(c: Json): string {
  return line([`#${val(c.id) ?? "?"}`, val(c.name) ?? line([val(c.lastname), val(c.firstname)]) ?? undefined]);
}

export function formatContactList(resp: unknown, pageSize: number, offset: number, hasMore: boolean, concise = false): string {
  return renderPagedList("Контакты", "get_contacts", resp, ["contacts"], (c) => (concise ? conciseContactRow(c) : formatContact(c)), pageSize, offset, hasMore);
}

export function formatSingleContact(resp: unknown): string {
  const c = obj(obj(resp)?.contact) ?? obj(resp);
  return c ? formatContact(c) : jsonFallback(resp);
}

// ── Projects ──────────────────────────────────────────────────────────────────

export function formatProject(p: Json): string {
  return line([`#${val(p.id) ?? "?"}`, val(p.name), ref(p.status) && `статус: ${ref(p.status)}`]);
}

export function formatProjectList(resp: unknown, pageSize: number, offset: number, hasMore: boolean): string {
  return renderPagedList("Проекты", "get_projects", resp, ["projects"], (p) => formatProject(p), pageSize, offset, hasMore);
}

export function formatSingleProject(resp: unknown): string {
  const p = obj(obj(resp)?.project) ?? obj(resp);
  if (!p) return jsonFallback(resp);
  const desc = val(p.description);
  return [formatProject(p), desc ? `\nОписание:\n${desc}` : ""].join("");
}

// ── Users ─────────────────────────────────────────────────────────────────────

export function formatUser(u: Json): string {
  return line([
    `#${val(u.id) ?? "?"}`,
    val(u.name) ?? line([val(u.lastname), val(u.firstname), val(u.midname)]),
    val(u.email) && `email: ${val(u.email)}`,
    ref(u.position) && `должность: ${ref(u.position)}`,
  ]);
}

export function formatUserList(resp: unknown, pageSize: number, offset: number, hasMore: boolean): string {
  return renderPagedList("Сотрудники", "list_users", resp, ["users"], (u) => formatUser(u), pageSize, offset, hasMore);
}

export function formatSingleUser(resp: unknown): string {
  const u = obj(obj(resp)?.user) ?? obj(resp);
  return u ? formatUser(u) : jsonFallback(resp);
}

// ── Comments ────────────────────────────────────────────────────────────────────

function commentRow(c: Json, concise = false): string {
  return line([
    `#${val(c.id) ?? "?"}`,
    ref(c.owner) && `автор: ${ref(c.owner)}`,
    dateStr(c.dateTime) && dateStr(c.dateTime),
    concise ? undefined : val(c.description),
  ]);
}

export function formatCommentList(resp: unknown, pageSize: number, offset: number, hasMore: boolean): string {
  return renderPagedList("Комментарии", "get_comments", resp, ["comments"], (c) => commentRow(c), pageSize, offset, hasMore);
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
  if (shown.length === 0) return `${head}\n\nКомментарии: нет.\nhas_more: false`;
  const body = shown.map((it, i) => `${i + 1}. ${commentRow(obj(it) ?? {}, opts.concise)}`).join("\n");
  const footer = hasMore
    ? `has_more: true — fetch the remaining comments with get_comments (taskId: ${opts.taskId}, offset: ${opts.limit}).`
    : "has_more: false";
  return `${head}\n\nКомментарии (${shown.length}${hasMore ? "+" : ""}):\n${body}\n${footer}`;
}

// ── Task search (search_tasks) ────────────────────────────────────────────────

function taskSearchRow(t: Json): string {
  return line([
    `#${val(t.id) ?? "?"}`,
    val(t.name),
    ref(t.status) && `статус: ${ref(t.status)}`,
    peopleNames(t.assignees) && `исполнители: ${peopleNames(t.assignees)}`,
    ref(t.project) && `проект: ${ref(t.project)}`,
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
  return `Задачи (${shown.length}${hasMore ? "+" : ""}):\n${body}\n${footer}`;
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
  return `Записи времени (${shown.length}${hasMore ? "+" : ""}):\n${body}\n${footer}`;
}

// ── Directories / custom fields / datatags ───────────────────────────────────────

export function formatDirectoryList(resp: unknown, pageSize: number, offset: number, hasMore: boolean): string {
  return renderPagedList("Справочники", "list_directories", resp, ["directories"], (d) =>
    line([`#${val(d.id) ?? "?"}`, val(d.name)]), pageSize, offset, hasMore);
}

export function formatDirectoryEntryList(resp: unknown, pageSize: number, offset: number, hasMore: boolean): string {
  return renderPagedList("Записи справочника", "list_directory_entries", resp, ["directoryEntries", "entries"], (e) =>
    line([`#${val(e.key) ?? val(e.id) ?? "?"}`, val(e.name)]), pageSize, offset, hasMore);
}

export function formatCustomFieldList(resp: unknown, pageSize: number, offset: number, hasMore: boolean): string {
  return renderPagedList("Кастомные поля", "list_custom_fields", resp, ["customFields", "customfields", "fields"], (f) =>
    line([`#${val(f.id) ?? "?"}`, val(f.name), ref(f.type) && `тип: ${ref(f.type)}`]), pageSize, offset, hasMore);
}

export function formatDatatagList(resp: unknown, pageSize: number, offset: number, hasMore: boolean): string {
  return renderPagedList("Дата-теги", "list_datatags", resp, ["dataTags", "datatags"], (d) =>
    line([`#${val(d.id) ?? "?"}`, val(d.name)]), pageSize, offset, hasMore);
}

export function formatFile(resp: unknown): string {
  const f = obj(obj(resp)?.file) ?? obj(resp);
  if (!f) return jsonFallback(resp);
  return line([`#${val(f.id) ?? "?"}`, val(f.name), val(f.size) && `размер: ${val(f.size)}`]);
}

// ── Write acknowledgements ────────────────────────────────────────────────────────

/** Подтверждение создания: ответ Planfix `{result, id}`. */
export function formatCreated(label: string, resp: unknown): string {
  const id = val(obj(resp)?.id);
  return id ? `✓ ${label} создан, ID: ${id}` : `✓ ${label} создан.\n${jsonFallback(resp)}`;
}

/**
 * Подтверждение обновления. Planfix отвечает пустым телом (200/202),
 * поэтому формируем осмысленное сообщение из id, переданного вызывающим.
 */
export function formatUpdated(label: string, id: number | string): string {
  return `✓ ${label} #${id} обновлён.`;
}
