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
function findArray(resp: unknown, keys: string[]): unknown[] | undefined {
  const o = obj(resp);
  if (!o) return undefined;
  for (const k of keys) if (Array.isArray(o[k])) return o[k] as unknown[];
  for (const v of Object.values(o)) if (Array.isArray(v)) return v as unknown[];
  return undefined;
}

function line(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(" | ");
}

function pageHint(count: number, pageSize?: number, offset?: number): string {
  if (pageSize && count === pageSize) {
    const next = (offset ?? 0) + pageSize;
    return `\n…возможно есть ещё — запросите offset=${next}.`;
  }
  return "";
}

function renderList(
  label: string,
  resp: unknown,
  keys: string[],
  render: (item: Json, index: number) => string,
  pageSize?: number,
  offset?: number,
): string {
  const items = findArray(resp, keys);
  if (!items) return jsonFallback(resp);
  if (items.length === 0) return `${label}: ничего не найдено.`;
  const body = items.map((it, i) => `${i + 1}. ${render(obj(it) ?? {}, i)}`).join("\n");
  return `${label} (${items.length}):\n${body}${pageHint(items.length, pageSize, offset)}`;
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

export function formatTaskList(resp: unknown, pageSize?: number, offset?: number): string {
  return renderList("Задачи", resp, ["tasks"], (t) => formatTask(t), pageSize, offset);
}

export function formatSingleTask(resp: unknown): string {
  const t = obj(obj(resp)?.task) ?? obj(resp);
  if (!t) return jsonFallback(resp);
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

export function formatContactList(resp: unknown, pageSize?: number, offset?: number): string {
  return renderList("Контакты", resp, ["contacts"], (c) => formatContact(c), pageSize, offset);
}

export function formatSingleContact(resp: unknown): string {
  const c = obj(obj(resp)?.contact) ?? obj(resp);
  return c ? formatContact(c) : jsonFallback(resp);
}

// ── Projects ──────────────────────────────────────────────────────────────────

export function formatProject(p: Json): string {
  return line([`#${val(p.id) ?? "?"}`, val(p.name), ref(p.status) && `статус: ${ref(p.status)}`]);
}

export function formatProjectList(resp: unknown, pageSize?: number, offset?: number): string {
  return renderList("Проекты", resp, ["projects"], (p) => formatProject(p), pageSize, offset);
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

export function formatUserList(resp: unknown, pageSize?: number, offset?: number): string {
  return renderList("Сотрудники", resp, ["users"], (u) => formatUser(u), pageSize, offset);
}

export function formatSingleUser(resp: unknown): string {
  const u = obj(obj(resp)?.user) ?? obj(resp);
  return u ? formatUser(u) : jsonFallback(resp);
}

// ── Comments ────────────────────────────────────────────────────────────────────

function commentRow(c: Json): string {
  return line([
    `#${val(c.id) ?? "?"}`,
    ref(c.owner) && `автор: ${ref(c.owner)}`,
    dateStr(c.dateTime) && dateStr(c.dateTime),
    val(c.description),
  ]);
}

export function formatCommentList(resp: unknown, pageSize?: number, offset?: number): string {
  return renderList("Комментарии", resp, ["comments"], commentRow, pageSize, offset);
}

// ── Composite: task + comments (get_task_full) ────────────────────────────────

/**
 * Renders a task card followed by its comments. `commentsResp` is expected to
 * hold up to `limit + 1` comments (the caller over-fetches one row), so
 * `has_more` here is exact, not a page-boundary heuristic.
 */
export function formatTaskFull(
  taskResp: unknown,
  commentsResp: unknown,
  opts: { taskId: number; limit: number },
): string {
  const head = formatSingleTask(taskResp);
  const items = findArray(commentsResp, ["comments"]);
  if (!items) return `${head}\n\n${jsonFallback(commentsResp)}`;
  const hasMore = items.length > opts.limit;
  const shown = hasMore ? items.slice(0, opts.limit) : items;
  if (shown.length === 0) return `${head}\n\nКомментарии: нет.\nhas_more: false`;
  const body = shown.map((it, i) => `${i + 1}. ${commentRow(obj(it) ?? {})}`).join("\n");
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
 * Compact search result rows with exact pagination metadata. `resp` is expected
 * to hold up to `pageSize + 1` tasks (the caller over-fetches one row), so
 * `has_more` is exact; the extra row is never rendered.
 */
export function formatTaskSearchList(resp: unknown, pageSize: number, offset: number): string {
  const items = findArray(resp, ["tasks"]);
  if (!items) return jsonFallback(resp);
  const hasMore = items.length > pageSize;
  const shown = hasMore ? items.slice(0, pageSize) : items;
  if (shown.length === 0) {
    return "No tasks matched the given filters. has_more: false. Try relaxing the filters (e.g. drop updatedSince or shorten nameContains).";
  }
  const body = shown.map((it, i) => `${offset + i + 1}. ${taskSearchRow(obj(it) ?? {})}`).join("\n");
  const footer = hasMore
    ? `has_more: true — next page: search_tasks with the same filters and offset: ${offset + pageSize}.`
    : "has_more: false";
  return `Задачи (${shown.length}${hasMore ? "+" : ""}):\n${body}\n${footer}`;
}

// ── Directories / custom fields / datatags ───────────────────────────────────────

export function formatDirectoryList(resp: unknown): string {
  return renderList("Справочники", resp, ["directories"], (d) =>
    line([`#${val(d.id) ?? "?"}`, val(d.name)]),
  );
}

export function formatDirectoryEntryList(resp: unknown): string {
  return renderList("Записи справочника", resp, ["directoryEntries", "entries"], (e) =>
    line([`#${val(e.key) ?? val(e.id) ?? "?"}`, val(e.name)]),
  );
}

export function formatCustomFieldList(resp: unknown): string {
  return renderList("Кастомные поля", resp, ["customFields", "fields"], (f) =>
    line([`#${val(f.id) ?? "?"}`, val(f.name), ref(f.type) && `тип: ${ref(f.type)}`]),
  );
}

export function formatDatatagList(resp: unknown): string {
  return renderList("Дата-теги", resp, ["dataTags", "datatags"], (d) =>
    line([`#${val(d.id) ?? "?"}`, val(d.name)]),
  );
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
