import { z } from "zod";
import { planfixPost, planfixGet } from "../client.js";
import { formatTaskList, formatSingleTask, formatCreated, formatUpdated, formatTaskFull, formatTaskSearchList } from "../format.js";
import { assertCreateTaskAllowed, assertTaskInTestProject } from "../safemode.js";

// Без явного `fields` Planfix возвращает почти пустые (id-only) объекты,
// поэтому всегда запрашиваем осмысленный набор полей.
const TASK_FIELDS = "id,name,description,status,priority,assignees,project,startDateTime,endDateTime";

// Ad-hoc фильтр Planfix: { type, operator, value } (комбинируются по AND).
const filterSchema = z.object({
  type: z.number().describe("Тип фильтра (числовой код Planfix, напр. 8 — имя, 51 — шаблон)"),
  operator: z.string().describe("Оператор сравнения, напр. 'equal', 'gt', 'lt'"),
  value: z.unknown().describe("Значение фильтра"),
});

export const getTasksSchema = z.object({
  offset: z.number().optional().describe("Смещение для пагинации (по умолчанию 0)"),
  pageSize: z.number().optional().describe("Количество задач на странице (по умолчанию 100)"),
  filterId: z.union([z.string(), z.number()]).optional().describe("ID сохранённого фильтра задач (см. /task/filters)"),
  filters: z.array(filterSchema).optional().describe("Массив ad-hoc фильтров для произвольной фильтрации"),
  fields: z.string().optional().describe(`Список полей через запятую (по умолчанию: ${TASK_FIELDS})`),
});

export async function handleGetTasks(params: z.infer<typeof getTasksSchema>): Promise<string> {
  const offset = params.offset ?? 0;
  const pageSize = params.pageSize ?? 100;
  const result = await planfixPost("task/list", {
    offset,
    pageSize,
    fields: params.fields ?? TASK_FIELDS,
    ...(params.filterId !== undefined ? { filterId: String(params.filterId) } : {}),
    ...(params.filters ? { filters: params.filters } : {}),
  });
  return formatTaskList(result, pageSize, offset);
}

export const getTaskSchema = z.object({
  taskId: z.number().describe("ID задачи"),
  fields: z.string().optional().describe(`Список полей через запятую (по умолчанию: ${TASK_FIELDS})`),
});

export async function handleGetTask(params: z.infer<typeof getTaskSchema>): Promise<string> {
  const result = await planfixGet(`task/${params.taskId}`, { fields: params.fields ?? TASK_FIELDS });
  return formatSingleTask(result);
}

export const createTaskSchema = z.object({
  name: z.string().describe("Название задачи"),
  description: z.string().optional().describe("Описание задачи"),
  projectId: z.number().optional().describe("ID проекта"),
  assigneeId: z.number().optional().describe("ID исполнителя (сотрудника). Найти ID: инструмент list_users"),
  // ВНИМАНИЕ: priority — строка, но точные допустимые значения не верифицированы
  // против live API. Передаётся как есть.
  priority: z.string().optional().describe("Приоритет задачи (строка). Допустимые значения не верифицированы против live API"),
});

export async function handleCreateTask(params: z.infer<typeof createTaskSchema>): Promise<string> {
  assertCreateTaskAllowed(params.projectId);
  const body: Record<string, unknown> = { name: params.name };
  if (params.description) body.description = params.description;
  if (params.projectId) body.project = { id: params.projectId };
  // Planfix ждёт PeopleRequest: { users: [{ id: "user:<N>" }] }, id — строка с префиксом.
  if (params.assigneeId) body.assignees = { users: [{ id: `user:${params.assigneeId}` }] };
  if (params.priority) body.priority = params.priority;

  const result = await planfixPost("task/", body);
  return formatCreated("Задача", result);
}

export const updateTaskSchema = z.object({
  taskId: z.number().describe("ID задачи"),
  name: z.string().optional().describe("Новое название"),
  description: z.string().optional().describe("Новое описание"),
  status: z.number().optional().describe("ID нового статуса"),
  assigneeId: z.number().optional().describe("ID нового исполнителя (см. list_users)"),
});

export async function handleUpdateTask(params: z.infer<typeof updateTaskSchema>): Promise<string> {
  await assertTaskInTestProject("update_task", params.taskId);
  const body: Record<string, unknown> = {};
  if (params.name) body.name = params.name;
  if (params.description) body.description = params.description;
  if (params.status) body.status = { id: params.status };
  if (params.assigneeId) body.assignees = { users: [{ id: `user:${params.assigneeId}` }] };

  // Planfix возвращает пустое тело (200 — применено, 202 — поставлено в очередь);
  // подтверждение формируем из taskId.
  await planfixPost(`task/${params.taskId}`, body);
  return formatUpdated("Задача", params.taskId);
}

// ── get_task_full — task + comments in one call (read-only) ──────────────────

const COMMENT_FIELDS = "id,dateTime,owner,description";
const DEFAULT_COMMENTS_LIMIT = 30;

export const getTaskFullSchema = z.object({
  taskId: z.number().int().positive().describe("ID задачи"),
  commentsLimit: z.number().int().min(1).max(100).optional()
    .describe(`Максимум комментариев в ответе (по умолчанию ${DEFAULT_COMMENTS_LIMIT}, максимум 100)`),
});

export async function handleGetTaskFull(params: z.infer<typeof getTaskFullSchema>): Promise<string> {
  const limit = params.commentsLimit ?? DEFAULT_COMMENTS_LIMIT;
  // Over-fetch one comment row so has_more is exact rather than a
  // page-boundary heuristic; the extra row is never rendered.
  const [taskResp, commentsResp] = await Promise.all([
    planfixGet(`task/${params.taskId}`, { fields: TASK_FIELDS }),
    planfixPost(`task/${params.taskId}/comments/list`, {
      offset: 0,
      pageSize: limit + 1,
      fields: COMMENT_FIELDS,
    }),
  ]);
  return formatTaskFull(taskResp, commentsResp, { taskId: params.taskId, limit });
}

// ── search_tasks — filtered discovery (read-only) ─────────────────────────────

// Planfix complex task filter mapping
// (https://planfix.com/help/REST_API:_Complex_task_filters):
//   type 8  — task name; operator "equal" means "contains" for string values
//   type 2  — assignee;  value is the prefixed string "user:<id>"
//   type 10 — status;    value is the numeric status id
//   type 5  — project;   value is the numeric project id
//   type 79 — date of latest change OR comment; operator "gt",
//             value { dateType: "otherDate", dateValue: "DD-MM-YYYY" }
//             Type 79 over type 38 ("latest change" only) is deliberate: the
//             primary consumer is the task-mirror sync, where a new comment
//             must count as task activity — type 38 misses comment-only
//             activity. The `dateValue` field name was verified live against
//             production (boundary test 2026-07-24: 2026-07-23 matches,
//             2026-07-25 empty); the docs' "dateFrom" is wrong or an
//             alternative.
// Filters combine with AND.

const SEARCH_FIELDS = "id,name,status,assignees,project";
const DEFAULT_SEARCH_PAGE_SIZE = 50;

export const searchTasksSchema = z.object({
  nameContains: z.string().min(1).optional().describe("Подстрока в названии задачи"),
  assigneeId: z.number().int().positive().optional().describe("ID исполнителя (сотрудника). Найти ID: инструмент list_users"),
  statusId: z.number().int().positive().optional().describe("ID статуса задачи"),
  projectId: z.number().int().positive().optional().describe("ID проекта"),
  updatedSince: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "updatedSince must be an ISO date in YYYY-MM-DD format, e.g. 2026-07-01")
    .optional()
    .describe("Только задачи с изменениями или комментариями после этой даты (ISO, YYYY-MM-DD)"),
  offset: z.number().int().min(0).optional().describe("Смещение для пагинации (по умолчанию 0)"),
  pageSize: z.number().int().min(1).max(100).optional()
    .describe(`Результатов на странице (по умолчанию ${DEFAULT_SEARCH_PAGE_SIZE}, максимум 100)`),
});

export async function handleSearchTasks(params: z.infer<typeof searchTasksSchema>): Promise<string> {
  const filters: Array<{ type: number; operator: string; value: unknown }> = [];
  if (params.nameContains !== undefined) filters.push({ type: 8, operator: "equal", value: params.nameContains });
  if (params.assigneeId !== undefined) filters.push({ type: 2, operator: "equal", value: `user:${params.assigneeId}` });
  if (params.statusId !== undefined) filters.push({ type: 10, operator: "equal", value: params.statusId });
  if (params.projectId !== undefined) filters.push({ type: 5, operator: "equal", value: params.projectId });
  if (params.updatedSince !== undefined) {
    const [y, m, d] = params.updatedSince.split("-");
    filters.push({ type: 79, operator: "gt", value: { dateType: "otherDate", dateValue: `${d}-${m}-${y}` } });
  }

  if (filters.length === 0) {
    throw new Error(
      "search_tasks requires at least one filter: nameContains, assigneeId, statusId, projectId, or updatedSince. " +
      "To page through all tasks without filters, use get_tasks instead.",
    );
  }

  const offset = params.offset ?? 0;
  const pageSize = params.pageSize ?? DEFAULT_SEARCH_PAGE_SIZE;
  // Over-fetch one row so has_more is exact; the extra row is never rendered.
  const result = await planfixPost("task/list", {
    offset,
    pageSize: pageSize + 1,
    fields: SEARCH_FIELDS,
    filters,
  });
  return formatTaskSearchList(result, pageSize, offset);
}
