import { z } from "zod";
import { planfixPost } from "../client.js";
import { assertTaskInTestProject } from "../safemode.js";
import { formatTimeEntryList, jsonFallback, findArray } from "../format.js";

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
  taskId: z.number().int().positive().describe("Task ID"),
  date: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be an ISO date in YYYY-MM-DD format, e.g. 2026-07-24")
    .describe("Date the time is logged for (ISO, YYYY-MM-DD)"),
  timeFrom: z.string()
    .regex(HHMM, "timeFrom must be a 24-hour time in HH:MM format, e.g. 09:30")
    .describe("Interval start (HH:MM)"),
  timeTo: z.string()
    .regex(HHMM, "timeTo must be a 24-hour time in HH:MM format, e.g. 18:00")
    .describe("Interval end (HH:MM)"),
  type: z.enum(TIME_ENTRY_TYPES).describe("Work type: Task, Meeting, Feedback, or Edits"),
  comment: z.string().min(1).describe("What the time was spent on"),
  userId: z.number().int().positive().describe("ID of the employee whose time is logged. Find it with the list_users tool"),
  commentId: z.number().int().positive().optional()
    .describe("ID of an existing logging-period comment: the entry is appended to it instead of creating a new comment"),
});

type TimeEntryWrite = z.infer<typeof addTimeEntrySchema>;

/**
 * The single time-entry write path — shared by add_time_entry and log_workday
 * so the safe-mode guard and the endpoint-variant handling exist exactly once.
 * `tool` names the caller in safe-mode refusals.
 */
async function writeTimeEntry(
  params: TimeEntryWrite,
  tool: string,
): Promise<{ key: unknown; commentId: unknown; raw: unknown }> {
  await assertTaskInTestProject(tool, params.taskId);

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
  return { key, commentId, raw: result };
}

export async function handleAddTimeEntry(params: z.infer<typeof addTimeEntrySchema>): Promise<string> {
  const { key, commentId, raw } = await writeTimeEntry(params, "add_time_entry");
  if (key === undefined || commentId === undefined) {
    return `Time entry request accepted, but the response had an unexpected shape (no keys/commentId):\n${jsonFallback(raw)}`;
  }
  return (
    `✓ Time entry created: key ${key}, commentId ${commentId}. ` +
    `To add more entries to the same logging-period comment, call add_time_entry again with commentId: ${commentId}.`
  );
}

// ── log_workday — validated day-level composite (ROADMAP P4) ──────────────────
// No org- or person-specific time convention is hardcoded or defaulted here:
// no-work windows (lunch, meetings, breaks) are cut out ONLY via the required
// `exclusions` input. Callers' conventions live on the caller's side.

const workdayEntrySchema = z.object({
  taskId: z.number().int().positive().describe("Task ID"),
  timeFrom: z.string().regex(HHMM, "timeFrom must be a 24-hour time in HH:MM format, e.g. 09:30").describe("Interval start (HH:MM)"),
  timeTo: z.string().regex(HHMM, "timeTo must be a 24-hour time in HH:MM format, e.g. 18:00").describe("Interval end (HH:MM)"),
  type: z.enum(TIME_ENTRY_TYPES).describe("Work type: Task, Meeting, Feedback, or Edits"),
  comment: z.string().min(1).describe("What the time was spent on"),
});

const exclusionSchema = z.object({
  timeFrom: z.string().regex(HHMM, "exclusion timeFrom must be a 24-hour time in HH:MM format, e.g. 13:00").describe("Window start (HH:MM)"),
  timeTo: z.string().regex(HHMM, "exclusion timeTo must be a 24-hour time in HH:MM format, e.g. 13:45").describe("Window end (HH:MM)"),
  label: z.string().min(1).optional().describe('Short reason, e.g. "lunch" or "all-hands"'),
});

const EXCLUSIONS_REQUIRED_MSG =
  "exclusions is required and has deliberately no default: pass the day's no-work windows to cut out of every logged interval " +
  '(e.g. [{ timeFrom: "13:00", timeTo: "13:45", label: "lunch" }]), or [] to log straight through with no cut-outs.';

export const logWorkdaySchema = z.object({
  date: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be an ISO date in YYYY-MM-DD format, e.g. 2026-07-24")
    .describe("The day being logged (ISO, YYYY-MM-DD)"),
  userId: z.number().int().positive().describe("ID of the employee whose time is logged. Find it with the list_users tool"),
  entries: z.array(workdayEntrySchema).min(1).describe("All intervals of the day, any task mix"),
  exclusions: z.array(exclusionSchema, { required_error: EXCLUSIONS_REQUIRED_MSG })
    .describe("REQUIRED, no default: no-work windows (lunch, meetings, breaks) cut out of every logged interval. [] = no cut-outs"),
  validate_only: z.boolean().optional()
    .describe("true: validate and return the resolved write plan without writing anything (recommended first pass)"),
});

type Workday = z.infer<typeof logWorkdaySchema>;

/** Post-split write unit. `from`/`to` in minutes since midnight. */
type Segment = {
  taskId: number;
  from: number;
  to: number;
  type: (typeof TIME_ENTRY_TYPES)[number];
  comment: string;
  sourceIndex: number;    // 1-based index of the input entry
  splitBy: string[];      // labels of the exclusion windows that cut this segment's edges
};

/** Normalized (merged) exclusion window. */
type Window = { from: number; to: number; label: string };

const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const toHHMM = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const fmtDur = (min: number): string => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
};
const segLabel = (s: Segment): string =>
  `${toHHMM(s.from)}-${toHHMM(s.to)}${s.splitBy.length ? ` (auto-split: ${s.splitBy.join(", ")})` : ""}`;
const windowLabel = (w: Window): string => `${toHHMM(w.from)}-${toHHMM(w.to)} (${w.label})`;

/** Validate + sort + merge overlapping/adjacent exclusion windows. */
function normalizeExclusions(exclusions: Workday["exclusions"]): { windows: Window[]; errors: string[] } {
  const errors: string[] = [];
  const raw: Window[] = [];
  exclusions.forEach((x, i) => {
    const from = toMin(x.timeFrom);
    const to = toMin(x.timeTo);
    if (from >= to) {
      errors.push(`exclusion ${i + 1} (${x.timeFrom}-${x.timeTo}): timeFrom must be earlier than timeTo.`);
      return;
    }
    raw.push({ from, to, label: x.label ?? `${x.timeFrom}-${x.timeTo}` });
  });
  raw.sort((a, b) => a.from - b.from || a.to - b.to);
  const windows: Window[] = [];
  for (const w of raw) {
    const last = windows[windows.length - 1];
    if (last && w.from <= last.to) {
      // overlapping or adjacent — merge, combining labels
      last.to = Math.max(last.to, w.to);
      if (!last.label.split(" + ").includes(w.label)) last.label += ` + ${w.label}`;
    } else {
      windows.push({ ...w });
    }
  }
  return { windows, errors };
}

/**
 * Pure validation + exclusion-window splitting. Every logged interval is cut
 * around every window (one interval may become several segments; partial
 * window overlap cuts too; zero-length remainders are dropped). Returns either
 * the full post-split segment list or the complete list of violations — never
 * a partial mix.
 */
function planWorkday(entries: Workday["entries"], windows: Window[]): { segments: Segment[]; errors: string[] } {
  const errors: string[] = [];
  const segments: Segment[] = [];

  entries.forEach((e, i) => {
    const idx = i + 1;
    const from = toMin(e.timeFrom);
    const to = toMin(e.timeTo);
    const label = `entry ${idx} (task ${e.taskId}, ${e.timeFrom}-${e.timeTo})`;

    if (from >= to) {
      errors.push(`${label}: timeFrom must be earlier than timeTo.`);
      return;
    }
    const base = { taskId: e.taskId, type: e.type, comment: e.comment, sourceIndex: idx };
    const hits = windows.filter((w) => w.from < to && w.to > from);
    if (hits.length === 0) {
      segments.push({ ...base, from, to, splitBy: [] });
      return;
    }
    // Cut the interval around every intersecting window; a segment is marked
    // with the label of each window that produced one of its edges.
    const produced: Segment[] = [];
    let cursor = from;
    let cursorCutBy: string | undefined; // window whose end moved the cursor
    for (const w of hits) {
      const segTo = Math.min(w.from, to);
      if (cursor < segTo) {
        const splitBy = [cursorCutBy, w.label].filter((s): s is string => Boolean(s));
        produced.push({ ...base, from: cursor, to: segTo, splitBy });
      }
      cursor = Math.max(cursor, w.to);
      cursorCutBy = w.label;
    }
    if (cursor < to) {
      produced.push({ ...base, from: cursor, to, splitBy: [cursorCutBy!] });
    }
    if (produced.length === 0) {
      errors.push(
        `${label}: lies entirely inside exclusion window(s) ${hits.map(windowLabel).join(", ")} — nothing remains to log.`,
      );
      return;
    }
    segments.push(...produced);
  });

  // Overlap check on the POST-SPLIT set (splits are subsets of their inputs, so
  // this also catches every overlap between the original intervals).
  const sorted = [...segments].sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.to > cur.from) {
      errors.push(
        `entries ${prev.sourceIndex} and ${cur.sourceIndex} overlap after exclusion-splitting: ` +
        `${segLabel(prev)} vs ${segLabel(cur)} — intervals of one day must not overlap, regardless of task.`,
      );
    }
  }

  return { segments, errors };
}

function groupByTask(segments: Segment[]): Map<number, Segment[]> {
  const byTask = new Map<number, Segment[]>();
  for (const s of segments) {
    const list = byTask.get(s.taskId) ?? [];
    list.push(s);
    byTask.set(s.taskId, list);
  }
  return byTask;
}

const total = (segs: Segment[]): number => segs.reduce((acc, s) => acc + (s.to - s.from), 0);

const exclusionsLine = (windows: Window[]): string =>
  windows.length ? `Exclusions applied: ${windows.map(windowLabel).join(", ")}.` : "Exclusions: none.";

function renderPlan(day: Workday, byTask: Map<number, Segment[]>, windows: Window[]): string {
  const lines: string[] = [
    `Workday plan for ${day.date} (user ${day.userId}) — validation passed, NOTHING written (validate_only).`,
    exclusionsLine(windows),
  ];
  for (const [taskId, segs] of byTask) {
    lines.push(`Task ${taskId} — ${segs.length} entr${segs.length === 1 ? "y" : "ies"}, ${fmtDur(total(segs))} (one comment, chained):`);
    for (const s of segs) lines.push(`  ${segLabel(s)} ${s.type} — ${s.comment}`);
  }
  const all = [...byTask.values()].flat();
  lines.push(`Day total: ${fmtDur(total(all))} across ${byTask.size} task${byTask.size === 1 ? "" : "s"}.`);
  lines.push("To write, call log_workday again without validate_only.");
  return lines.join("\n");
}

export async function handleLogWorkday(params: Workday): Promise<string> {
  const refuse = (errors: string[]): never => {
    throw new Error(
      `log_workday refused — the day failed validation; NOTHING was written. Violations:\n` +
      errors.map((e) => `- ${e}`).join("\n"),
    );
  };
  const { windows, errors: windowErrors } = normalizeExclusions(params.exclusions);
  if (windowErrors.length > 0) refuse(windowErrors);
  const { segments, errors } = planWorkday(params.entries, windows);
  if (errors.length > 0) refuse(errors);
  const byTask = groupByTask(segments);

  if (params.validate_only) return renderPlan(params, byTask, windows);

  // Safe mode: verify EVERY task upfront so a mid-list refusal cannot leave a
  // partially written day. (writeTimeEntry re-guards per write; redundant GETs
  // in safe mode only.) No-op when safe mode is off.
  for (const taskId of byTask.keys()) {
    await assertTaskInTestProject("log_workday", taskId);
  }

  // Write order: task by task; first entry opens the task's logging-period
  // comment, the rest chain onto it via commentId.
  const writeOrder = [...byTask.entries()].flatMap(([taskId, segs]) => segs.map((seg) => ({ taskId, seg })));
  const written: Array<{ taskId: number; seg: Segment; key: unknown; commentId: number }> = [];
  const taskComment = new Map<number, number>();

  for (let i = 0; i < writeOrder.length; i++) {
    const { taskId, seg } = writeOrder[i];
    try {
      const r = await writeTimeEntry({
        taskId,
        date: params.date,
        timeFrom: toHHMM(seg.from),
        timeTo: toHHMM(seg.to),
        type: seg.type,
        comment: seg.comment,
        userId: params.userId,
        commentId: taskComment.get(taskId),
      }, "log_workday");
      if (r.key === undefined || r.commentId === undefined) {
        throw new Error(`Planfix returned an unexpected response shape (no keys/commentId): ${jsonFallback(r.raw)}`);
      }
      const cid = Number(r.commentId);
      taskComment.set(taskId, cid);
      written.push({ taskId, seg, key: r.key, commentId: cid });
    } catch (err) {
      // Stop immediately — never retry (double-logging risk). Returned as a
      // plain (non-error) result so the caller does not blind-retry the call.
      const notWritten = writeOrder.slice(i);
      return [
        `log_workday PARTIALLY FAILED on ${params.date} — stopped at the first write error; writes are NEVER retried automatically (double-logging risk).`,
        `Written (${written.length}) — these CANNOT be rolled back (the API key has no delete scope; clean up from the Planfix UI if needed):`,
        ...written.map((w) => `- task ${w.taskId}: ${segLabel(w.seg)} → key ${w.key}, commentId ${w.commentId}`),
        `NOT written (${notWritten.length}):`,
        ...notWritten.map((w) => `- task ${w.taskId}: ${segLabel(w.seg)}`),
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      ].join("\n");
    }
  }

  const lines: string[] = [
    `✓ Workday ${params.date} logged for user ${params.userId}.`,
    exclusionsLine(windows),
  ];
  for (const [taskId, segs] of byTask) {
    const cid = taskComment.get(taskId);
    lines.push(`Task ${taskId} — ${segs.length} entr${segs.length === 1 ? "y" : "ies"}, ${fmtDur(total(segs))}, commentId ${cid}:`);
    for (const s of segs) {
      const w = written.find((x) => x.taskId === taskId && x.seg === s)!;
      lines.push(`  ${segLabel(s)} → key ${w.key}`);
    }
  }
  const all = [...byTask.values()].flat();
  lines.push(`Day total: ${fmtDur(total(all))} across ${byTask.size} task${byTask.size === 1 ? "" : "s"}.`);
  return lines.join("\n");
}

const ENTRY_FIELDS = `key,task,commentId,${FIELD_USER},${FIELD_DATE},${FIELD_TIME},${FIELD_TYPE},${FIELD_COMMENT}`;
const DEFAULT_ENTRIES_PAGE_SIZE = 30;

export const getTaskTimeEntriesSchema = z.object({
  taskId: z.number().int().positive().describe("Task ID"),
  offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
  // Max 99, not 100: the API caps pageSize at 100 and the handler over-fetches
  // one row to compute an exact has_more.
  pageSize: z.number().int().min(1).max(99).optional()
    .describe(`Entries per page (default ${DEFAULT_ENTRIES_PAGE_SIZE}, max 99)`),
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

// ── get_time_report — cross-task per-person workload (ROADMAP P10) ────────────

// Mechanics verified live (docs/spikes/time-report.md, 2026-07-26, re-verified
// by the reviewing session): POST /datatag/59/entry/list is task-agnostic and
// filters by data tag field values — type 3103 (List of users) on field 173
// with value "user:<N>", type 3101 (Date) on field 175 with an otherRange
// value that is INCLUSIVE on both ends. Every entry carries the user's display
// name (173 stringValue), a plain calendar date (175), and durationSec (185).
// Policy stays agent-side: no team roster and no working-day calendar exist in
// code — userIds is required, and "unlogged" defaults to Mon-Fri with zero
// entries unless the caller passes an explicit workingDays list. The output
// states which definition was used.

const FILTER_USER_LIST_FIELD = 3103;
const FILTER_DATE_FIELD = 3101;
const REPORT_FIELDS = `key,${FIELD_USER},${FIELD_DATE},${FIELD_TIME}`;
const REPORT_MAX_USERS = 10;
const REPORT_MAX_DAYS = 92;
const REPORT_MAX_PAGES_PER_USER = 10; // × 100 rows — totals become "N+" lower bounds when hit
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const getTimeReportSchema = z.object({
  userIds: z.array(z.number().int().positive()).min(1).max(REPORT_MAX_USERS)
    .describe(`Employee IDs to report on (1-${REPORT_MAX_USERS}). Find ids with list_users. No team roster exists in code — pass everyone you need`),
  dateFrom: z.string().regex(ISO_DATE, "dateFrom must be an ISO date in YYYY-MM-DD format, e.g. 2026-07-01")
    .describe("Range start (ISO, YYYY-MM-DD, inclusive)"),
  dateTo: z.string().regex(ISO_DATE, "dateTo must be an ISO date in YYYY-MM-DD format, e.g. 2026-07-31")
    .describe("Range end (ISO, YYYY-MM-DD, inclusive)"),
  workingDays: z.array(z.string().regex(ISO_DATE, "each workingDays item must be an ISO date in YYYY-MM-DD format")).optional()
    .describe("Explicit working-day calendar (ISO dates inside the range): unlogged days are computed against this list instead of the default Mon-Fri. No calendar exists in code"),
});

const isoToDdMmYyyy = (iso: string): string => {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
};
const ddMmYyyyToIso = (dmy: string): string | undefined => {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(dmy);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : undefined;
};
const isoToUtc = (iso: string): number => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const DAY_MS = 86_400_000;
const utcToIso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const isWeekday = (ms: number): boolean => {
  const dow = new Date(ms).getUTCDay();
  return dow >= 1 && dow <= 5;
};

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;

type UserReport = {
  userId: number;
  name?: string;
  entryCount: number;
  totalSec: number;
  perDay: Map<string, { sec: number; count: number }>; // ISO date → totals
  capped: boolean;
};

async function collectUserEntries(userId: number, dateFrom: string, dateTo: string): Promise<UserReport> {
  const report: UserReport = { userId, entryCount: 0, totalSec: 0, perDay: new Map(), capped: false };
  const filters = [
    { type: FILTER_USER_LIST_FIELD, field: FIELD_USER, operator: "equal", value: `user:${userId}` },
    { type: FILTER_DATE_FIELD, field: FIELD_DATE, operator: "equal", value: { dateType: "otherRange", dateFrom: isoToDdMmYyyy(dateFrom), dateTo: isoToDdMmYyyy(dateTo) } },
  ];
  for (let page = 0; page < REPORT_MAX_PAGES_PER_USER; page++) {
    const resp = await planfixPost("datatag/59/entry/list", {
      offset: page * 100,
      pageSize: 100,
      fields: REPORT_FIELDS,
      filters,
    });
    const items = findArray(resp, ["dataTagEntries", "entries"]) ?? [];
    for (const item of items) {
      const e = asObj(item);
      let iso: string | undefined;
      let sec = 0;
      for (const cf of (findArray(e ?? {}, ["customFieldData"]) ?? []).map(asObj)) {
        const fid = asObj(cf?.field)?.id;
        if (fid === FIELD_DATE) {
          const raw = asObj(cf?.value)?.date ?? cf?.stringValue;
          if (typeof raw === "string") iso = ddMmYyyyToIso(raw);
        } else if (fid === FIELD_TIME) {
          const dur = asObj(cf?.value)?.durationSec;
          if (typeof dur === "number") sec = dur;
        } else if (fid === FIELD_USER && report.name === undefined) {
          const n = cf?.stringValue;
          if (typeof n === "string" && n.length > 0) report.name = n;
        }
      }
      report.entryCount++;
      report.totalSec += sec;
      if (iso) {
        const day = report.perDay.get(iso) ?? { sec: 0, count: 0 };
        day.sec += sec;
        day.count++;
        report.perDay.set(iso, day);
      }
    }
    if (items.length < 100) return report;
  }
  report.capped = true; // every page up to the cap came back full — more may follow
  return report;
}

const fmtHours = (sec: number): string => fmtDur(Math.round(sec / 60));

export async function handleGetTimeReport(params: z.infer<typeof getTimeReportSchema>): Promise<string> {
  const fromMs = isoToUtc(params.dateFrom);
  const toMs = isoToUtc(params.dateTo);
  if (fromMs > toMs) {
    throw new Error(`dateFrom (${params.dateFrom}) must not be after dateTo (${params.dateTo}).`);
  }
  const rangeDays = Math.round((toMs - fromMs) / DAY_MS) + 1;
  if (rangeDays > REPORT_MAX_DAYS) {
    throw new Error(
      `The range ${params.dateFrom}..${params.dateTo} spans ${rangeDays} days — get_time_report is capped at ${REPORT_MAX_DAYS} days. ` +
      "Split the period into shorter ranges.",
    );
  }

  // Candidate working days: the caller's explicit calendar, or Mon-Fri.
  let candidates: string[];
  let definition: string;
  if (params.workingDays !== undefined) {
    const outside = params.workingDays.filter((d) => isoToUtc(d) < fromMs || isoToUtc(d) > toMs);
    if (outside.length > 0) {
      throw new Error(
        `workingDays must lie inside ${params.dateFrom}..${params.dateTo}; outside: ${outside.join(", ")}.`,
      );
    }
    candidates = [...new Set(params.workingDays)].sort();
    definition = `Unlogged = the ${candidates.length} caller-provided workingDays with zero entries.`;
  } else {
    candidates = [];
    for (let ms = fromMs; ms <= toMs; ms += DAY_MS) {
      if (isWeekday(ms)) candidates.push(utcToIso(ms));
    }
    definition = "Unlogged = Mon-Fri days in range with zero entries.";
  }

  // One query chain per user (multi-user single-call filtering unverified —
  // spike open question 1; cost is users × pages, measured cheap).
  const reports: UserReport[] = [];
  for (const userId of params.userIds) {
    reports.push(await collectUserEntries(userId, params.dateFrom, params.dateTo));
  }

  const lines: string[] = [
    `Time report ${params.dateFrom}..${params.dateTo} (${rangeDays} days, ${reports.length} user${reports.length === 1 ? "" : "s"}).`,
    definition,
  ];
  for (const r of reports) {
    const who = `user:${r.userId}${r.name ? ` ${r.name}` : ""}`;
    const unlogged = candidates.filter((d) => !r.perDay.has(d));
    lines.push("");
    if (r.entryCount === 0) {
      lines.push(`${who} — no entries in range.`);
      lines.push(`  Unlogged days (${unlogged.length} of ${candidates.length}): all working days in range.`);
      continue;
    }
    const plus = r.capped ? "+" : "";
    const capNote = r.capped
      ? ` (scan cap reached at ${REPORT_MAX_PAGES_PER_USER * 100} entries — totals are lower bounds; narrow the date range for exact numbers)`
      : "";
    const dayWord = r.perDay.size === 1 && !r.capped ? "day" : "days";
    const entryWord = r.entryCount === 1 && !r.capped ? "entry" : "entries";
    lines.push(`${who} — total ${fmtHours(r.totalSec)}${plus} across ${r.perDay.size}${plus} ${dayWord} (${r.entryCount}${plus} ${entryWord})${capNote}:`);
    for (const day of [...r.perDay.keys()].sort()) {
      const { sec, count } = r.perDay.get(day)!;
      lines.push(`  ${day}: ${fmtHours(sec)} (${count} entr${count === 1 ? "y" : "ies"})`);
    }
    lines.push(unlogged.length > 0
      ? `  Unlogged days (${unlogged.length} of ${candidates.length}): ${unlogged.join(", ")}`
      : `  Unlogged days: none of the ${candidates.length} working days.`);
  }
  return lines.join("\n");
}
