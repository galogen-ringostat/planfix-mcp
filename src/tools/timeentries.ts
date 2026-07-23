import { z } from "zod";
import { planfixPost } from "../client.js";
import { assertTaskInTestProject } from "../safemode.js";
import { formatTimeEntryList, jsonFallback } from "../format.js";

// Data tag 59 "Time spent" — the org's time-logging analytic. The data tag id,
// field ids, value formats, and endpoint behavior were verified live against
// production: see docs/spikes/time-entries.md (spike + design review, 2026-07-24).
const TIME_SPENT_DATATAG_ID = 59;
const FIELD_USER = 173;    // "Name" — list of users; write value [{ id: "user:<N>" }]
const FIELD_DATE = 175;    // "Date" — write value { date: "DD-MM-YYYY" }
const FIELD_TIME = 185;    // "Time" — clock range { from, to }; durationSec computed server-side
const FIELD_TYPE = 191;    // "Type" — enum list, write value is the enum string
const FIELD_COMMENT = 181; // "Comment" — short text
// Field 199 "Scoring" deliberately not exposed (design review answer 3).

const TIME_ENTRY_TYPES = ["Task", "Meeting", "Feedback", "Edits"] as const;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const addTimeEntrySchema = z.object({
  taskId: z.number().int().positive().describe("ID задачи"),
  date: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be an ISO date in YYYY-MM-DD format, e.g. 2026-07-24")
    .describe("Дата, за которую логируется время (ISO, YYYY-MM-DD)"),
  timeFrom: z.string()
    .regex(HHMM, "timeFrom must be a 24-hour time in HH:MM format, e.g. 09:30")
    .describe("Начало интервала (HH:MM)"),
  timeTo: z.string()
    .regex(HHMM, "timeTo must be a 24-hour time in HH:MM format, e.g. 18:00")
    .describe("Конец интервала (HH:MM)"),
  type: z.enum(TIME_ENTRY_TYPES).describe("Тип работы: Task, Meeting, Feedback или Edits"),
  comment: z.string().min(1).describe("Описание работы"),
  userId: z.number().int().positive().describe("ID сотрудника, чьё время логируется. Найти ID: инструмент list_users"),
  commentId: z.number().int().positive().optional()
    .describe("ID существующего комментария-периода: запись добавится в него вместо создания нового комментария"),
});

export async function handleAddTimeEntry(params: z.infer<typeof addTimeEntrySchema>): Promise<string> {
  await assertTaskInTestProject("add_time_entry", params.taskId);

  const [y, m, d] = params.date.split("-");
  // Without commentId Planfix creates a new comment holding the entry; with
  // commentId the entry is appended to that comment (one comment per logging
  // period holds several entries — the operator's convention).
  const endpoint = params.commentId !== undefined
    ? `task/${params.taskId}/datatags/${params.commentId}`
    : `task/${params.taskId}/datatags/`;

  const result = await planfixPost(endpoint, {
    dataTag: { id: TIME_SPENT_DATATAG_ID },
    items: [{
      customFieldData: [
        { field: { id: FIELD_USER }, value: [{ id: `user:${params.userId}` }] },
        { field: { id: FIELD_DATE }, value: { date: `${d}-${m}-${y}` } },
        { field: { id: FIELD_TIME }, value: { from: { time: params.timeFrom }, to: { time: params.timeTo } } },
        { field: { id: FIELD_TYPE }, value: params.type },
        { field: { id: FIELD_COMMENT }, value: params.comment },
      ],
    }],
  });

  const resp = result as { keys?: unknown[]; commentId?: unknown };
  const key = Array.isArray(resp?.keys) ? resp.keys[0] : undefined;
  // The response shape differs per endpoint variant (verified live, Layer 3
  // 2026-07-24): the new-comment POST returns { keys, commentId }, but the
  // append POST returns { keys } only — there the commentId is echoed from
  // the input, which is the comment the entry landed on.
  const commentId = params.commentId !== undefined ? params.commentId : resp?.commentId;
  if (key === undefined || commentId === undefined) {
    return `Time entry request accepted, but the response had an unexpected shape (no keys/commentId):\n${jsonFallback(result)}`;
  }
  return (
    `✓ Time entry created: key ${key}, commentId ${commentId}. ` +
    `To add more entries to the same logging-period comment, call add_time_entry again with commentId: ${commentId}.`
  );
}

const ENTRY_FIELDS = `key,task,commentId,${FIELD_USER},${FIELD_DATE},${FIELD_TIME},${FIELD_TYPE},${FIELD_COMMENT}`;
const DEFAULT_ENTRIES_PAGE_SIZE = 30;

export const getTaskTimeEntriesSchema = z.object({
  taskId: z.number().int().positive().describe("ID задачи"),
  offset: z.number().int().min(0).optional().describe("Смещение для пагинации (по умолчанию 0)"),
  // Max 99, not 100: the API caps pageSize at 100 and the handler over-fetches
  // one row to compute an exact has_more.
  pageSize: z.number().int().min(1).max(99).optional()
    .describe(`Записей на странице (по умолчанию ${DEFAULT_ENTRIES_PAGE_SIZE}, максимум 99)`),
});

export async function handleGetTaskTimeEntries(params: z.infer<typeof getTaskTimeEntriesSchema>): Promise<string> {
  const offset = params.offset ?? 0;
  const pageSize = params.pageSize ?? DEFAULT_ENTRIES_PAGE_SIZE;
  // Custom field values come back only when requested by NUMERIC field id in
  // `fields` (docs/spikes/time-entries.md, gotcha 1). taskId scopes the list
  // server-side. Over-fetch one row so has_more is exact.
  const result = await planfixPost(`datatag/${TIME_SPENT_DATATAG_ID}/entry/list`, {
    offset,
    pageSize: pageSize + 1,
    fields: ENTRY_FIELDS,
    taskId: params.taskId,
  });
  return formatTimeEntryList(result, pageSize, offset, {
    date: FIELD_DATE,
    time: FIELD_TIME,
    user: FIELD_USER,
    type: FIELD_TYPE,
    comment: FIELD_COMMENT,
  });
}
