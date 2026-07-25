import { z } from "zod";
import { planfixGet, planfixPost } from "../client.js";
import { formatCustomFieldList, findArray, jsonFallback } from "../format.js";
import { assertTaskInTestProject } from "../safemode.js";

// Custom fields are listed per object type: GET /customfield/{objectType}.
export const listCustomFieldsSchema = z.object({
  objectType: z
    .enum(["task", "contact", "project", "user", "main"])
    .describe("Object type whose custom fields are listed"),
  offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
  pageSize: z.number().int().min(1).optional().describe("Fields per page (default 100)"),
});

export async function handleListCustomFields(params: z.infer<typeof listCustomFieldsSchema>): Promise<string> {
  const offset = params.offset ?? 0;
  const pageSize = params.pageSize ?? 100;
  // The endpoint is a GET with no server-side pagination — it returns ALL
  // fields of the object type. Pagination (and the exact has_more) is applied
  // client-side over the full response.
  const result = await planfixGet(`customfield/${params.objectType}`);
  const all = findArray(result, ["customFields", "customfields", "fields"]);
  if (!all) return formatCustomFieldList(result, pageSize, offset, false);
  const page = all.slice(offset, offset + pageSize);
  const hasMore = all.length > offset + pageSize;
  return formatCustomFieldList({ customfields: page }, pageSize, offset, hasMore);
}

// ── set_task_custom_field — validated List-field write (ROADMAP P9) ───────────

// The API validates NOTHING on custom-field writes (docs/spikes/
// task-custom-fields.md): values outside enumValues are stored verbatim, and
// writes to fields not attached to the task's template return success while
// storing nothing. Both silent-failure classes are guarded here: enum
// validation BEFORE the write, read-back verification AFTER it.

const LIST_FIELD_TYPE = 8;
const DATATAG_SUMMARY_TYPE = 23;

export const setTaskCustomFieldSchema = z.object({
  taskId: z.number().int().positive().describe("Task ID"),
  fieldId: z.number().int().positive().describe("Custom field ID. Find it with list_custom_fields (objectType: \"task\")"),
  value: z.string().min(1).describe("The option's exact label, e.g. \"Sprint 10 - 2026\" — validated against the field's allowed values before writing"),
});

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;

/** Look a task custom field up by id (the GET endpoint cannot filter by id). */
async function lookupTaskField(fieldId: number): Promise<Obj | undefined> {
  const resp = await planfixGet("customfield/task", { fields: "id,name,type,enumValues" });
  const all = findArray(resp, ["customFields", "customfields", "fields"]) ?? [];
  return all.map(asObj).find((f) => f?.id === fieldId);
}

export async function handleSetTaskCustomField(params: z.infer<typeof setTaskCustomFieldSchema>): Promise<string> {
  await assertTaskInTestProject("set_task_custom_field", params.taskId);

  const field = await lookupTaskField(params.fieldId);
  if (!field) {
    throw new Error(
      `Unknown task custom field id ${params.fieldId} — call list_custom_fields (objectType: "task") to discover field ids.`,
    );
  }
  const name = typeof field.name === "string" ? field.name : `#${params.fieldId}`;
  if (field.type === DATATAG_SUMMARY_TYPE) {
    throw new Error(
      `Custom field ${params.fieldId} "${name}" is a Data tag summary — a computed sum over data tag entries, never directly writable. ` +
      "Use add_estimation (estimation) or add_time_entry (time spent) instead.",
    );
  }
  if (field.type !== LIST_FIELD_TYPE) {
    throw new Error(
      `Custom field ${params.fieldId} "${name}" has type ${field.type}; set_task_custom_field supports List fields (type ${LIST_FIELD_TYPE}) only. ` +
      "For other field types use the Planfix UI.",
    );
  }
  // The API stores ANY string on a List field, even outside its options —
  // deterministic validation here is the only gate.
  const options = Array.isArray(field.enumValues) ? (field.enumValues as unknown[]).filter((v): v is string => typeof v === "string") : [];
  if (options.length > 0 && !options.includes(params.value)) {
    throw new Error(
      `"${params.value}" is not an allowed value of custom field ${params.fieldId} "${name}". ` +
      `Allowed values: ${options.map((o) => `"${o}"`).join(", ")}.`,
    );
  }

  await planfixPost(`task/${params.taskId}`, {
    customFieldData: [{ field: { id: params.fieldId }, value: params.value }],
  });

  // Read-back verification: a write to a field not attached to the task's
  // template returns success and stores nothing — surface that as an error.
  const readBack = await planfixGet(`task/${params.taskId}`, { fields: `id,${params.fieldId}` });
  const stored = (findArray(asObj(asObj(readBack)?.task) ?? {}, ["customFieldData"]) ?? [])
    .map(asObj)
    .find((e) => asObj(e?.field)?.id === params.fieldId);
  const storedValue = stored?.stringValue ?? stored?.value;
  if (storedValue !== params.value) {
    throw new Error(
      `Write to custom field ${params.fieldId} "${name}" on task ${params.taskId} did NOT persist ` +
      `(the API reported success but read-back shows ${stored ? `"${String(storedValue)}"` : "no value"}). ` +
      "Most likely the field is not attached to this task's template — fields writable on this task are the ones " +
      "get_task returns when their ids are requested in `fields`.",
    );
  }
  return `✓ Custom field ${params.fieldId} "${name}" set to "${params.value}" on task ${params.taskId} (verified by read-back).`;
}

// ── add_estimation — estimation entries via data tag 61 (ROADMAP P9) ──────────

// Data tag 61 "Estimation" and its field ids were verified live (docs/spikes/
// task-custom-fields.md), same precedent as data tag 59 in timeentries.ts.
// The task's "Estimation RevOps" summary (22453, type 23) is the computed sum
// of these entries and updates immediately after a successful write.
const ESTIMATION_DATATAG_ID = 61;
const EST_FIELD_USER = 187;  // "Name" — list of users; write value [{ id: "user:<N>" }]
const EST_FIELD_TIME = 189;  // "Time" — clock range { from, to }; ONLY this shape counts:
//   - { durationSec } alone: stored EMPTY (silent no-op, key 127900 evidence)
//   - from 00:00 to 00:00: stores durationSec 86400 but the summary IGNORES it (key 127902)
//   - from 00:00 to "24:00": the working 24h chunk (key 127903; summary +24h verified)
const ESTIMATION_SUMMARY_FIELD_ID = 22453;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const FULL_DAY_MIN = 1440;

const workdayExclusionSchema = z.object({
  timeFrom: z.string().regex(HHMM, "exclusion timeFrom must be a 24-hour time in HH:MM format, e.g. 14:00").describe("Window start (HH:MM)"),
  timeTo: z.string().regex(HHMM, "exclusion timeTo must be a 24-hour time in HH:MM format, e.g. 15:00").describe("Window end (HH:MM)"),
});

const workdaySchema = z.object({
  from: z.string().regex(HHMM, "workday.from must be a 24-hour time in HH:MM format, e.g. 10:00").describe("Working day start (HH:MM)"),
  to: z.string().regex(HHMM, "workday.to must be a 24-hour time in HH:MM format, e.g. 19:00").describe("Working day end (HH:MM)"),
  exclusions: z.array(workdayExclusionSchema)
    .describe("No-work windows inside the day (e.g. lunch), skipped when laying out entries. [] = none. No default exists — conventions stay on the caller's side"),
});

export const addEstimationSchema = z.object({
  taskId: z.number().int().positive().describe("Task ID"),
  userId: z.number().int().positive().describe("ID of the employee the estimation belongs to. Find it with the list_users tool"),
  hours: z.number().positive().max(500)
    .describe("Total estimate in hours; fractions allowed at minute resolution (e.g. 10.5)"),
  workday: workdaySchema.optional()
    .describe("Optional visual layout: entries are laid out as working intervals of this day shape (from/to, skipping exclusions), " +
      "spilling into a new visual day when the total exceeds one day. Entries carry no dates — the layout is purely cosmetic. " +
      "There is NO default day shape: ask the operator for theirs. Omitted = plain maximal chunks (00:00-24:00 + remainder)"),
  validate_only: z.boolean().optional()
    .describe("true: validate and return the planned entries without writing anything"),
});

type Chunk = { from: number; to: number };

const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
/** 1440 renders as "24:00" — the only place a non-HH:MM boundary is valid (see EST_FIELD_TIME note). */
const toHHMM = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const fmtDur = (min: number): string => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
};

/**
 * Deterministic all-or-nothing chunk planning. Returns the full entry plan or
 * throws with every violation listed; nothing is ever partially planned.
 */
function planEstimationChunks(totalMin: number, workday?: z.infer<typeof workdaySchema>): { chunks: Chunk[]; days: number } {
  if (!workday) {
    const chunks: Chunk[] = [];
    let rem = totalMin;
    while (rem > 0) {
      const take = Math.min(rem, FULL_DAY_MIN);
      chunks.push({ from: 0, to: take });
      rem -= take;
    }
    return { chunks, days: chunks.length };
  }

  const errors: string[] = [];
  const dayFrom = toMin(workday.from);
  const dayTo = toMin(workday.to);
  if (dayFrom >= dayTo) errors.push(`workday ${workday.from}-${workday.to}: from must be earlier than to.`);

  const windows = workday.exclusions
    .map((x, i) => {
      const from = toMin(x.timeFrom);
      const to = toMin(x.timeTo);
      if (from >= to) errors.push(`exclusion ${i + 1} (${x.timeFrom}-${x.timeTo}): timeFrom must be earlier than timeTo.`);
      else if (from < dayFrom || to > dayTo) errors.push(`exclusion ${i + 1} (${x.timeFrom}-${x.timeTo}): must lie inside the workday ${workday.from}-${workday.to}.`);
      return { from, to };
    })
    .sort((a, b) => a.from - b.from || a.to - b.to);
  if (errors.length > 0) throw new Error(`add_estimation refused — invalid workday layout; NOTHING was written:\n${errors.map((e) => `- ${e}`).join("\n")}`);

  // Merge overlapping/adjacent windows, then derive the free segments.
  const merged: Chunk[] = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.from <= last.to) last.to = Math.max(last.to, w.to);
    else merged.push({ ...w });
  }
  const segments: Chunk[] = [];
  let cursor = dayFrom;
  for (const w of merged) {
    if (cursor < w.from) segments.push({ from: cursor, to: w.from });
    cursor = Math.max(cursor, w.to);
  }
  if (cursor < dayTo) segments.push({ from: cursor, to: dayTo });
  const perDay = segments.reduce((acc, s) => acc + (s.to - s.from), 0);
  if (perDay === 0) {
    throw new Error(
      `add_estimation refused — the exclusions cover the whole workday ${workday.from}-${workday.to}; no time remains to lay entries out. NOTHING was written.`,
    );
  }

  const chunks: Chunk[] = [];
  let rem = totalMin;
  while (rem > 0) {
    for (const seg of segments) {
      if (rem === 0) break;
      const take = Math.min(rem, seg.to - seg.from);
      chunks.push({ from: seg.from, to: seg.from + take });
      rem -= take;
    }
  }
  return { chunks, days: Math.ceil(totalMin / perDay) };
}

export async function handleAddEstimation(params: z.infer<typeof addEstimationSchema>): Promise<string> {
  const totalMin = Math.round(params.hours * 60);
  if (Math.abs(params.hours * 60 - totalMin) > 1e-9 || totalMin === 0) {
    throw new Error(`hours must be a positive whole number of minutes (e.g. 10.5 = 10h 30m); got ${params.hours}.`);
  }

  const { chunks, days } = planEstimationChunks(totalMin, params.workday);
  const chunkLabel = (c: Chunk) => `${toHHMM(c.from)}-${toHHMM(c.to)} (${fmtDur(c.to - c.from)})`;

  if (params.validate_only) {
    return [
      `Estimation plan for task ${params.taskId} (user ${params.userId}) — validation passed, NOTHING written (validate_only).`,
      `Total: ${fmtDur(totalMin)} in ${chunks.length} entr${chunks.length === 1 ? "y" : "ies"}${params.workday ? ` across ${days} visual day${days === 1 ? "" : "s"}` : ""}. APPEND semantics: this ADDS to the existing estimation sum.`,
      ...chunks.map((c, i) => `${i + 1}. ${chunkLabel(c)}`),
      "To write, call add_estimation again without validate_only.",
    ].join("\n");
  }

  await assertTaskInTestProject("add_estimation", params.taskId);

  // Entries chain onto one comment (production convention: an estimation's
  // entries share a commentId), same mechanism as add_time_entry.
  let commentId: number | undefined;
  const written: Array<{ chunk: Chunk; key: unknown }> = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    try {
      const endpoint = commentId !== undefined
        ? `task/${params.taskId}/datatags/${commentId}`
        : `task/${params.taskId}/datatags/`;
      const result = await planfixPost(endpoint, {
        dataTag: { id: ESTIMATION_DATATAG_ID },
        items: [{
          customFieldData: [
            { field: { id: EST_FIELD_USER }, value: [{ id: `user:${params.userId}` }] },
            { field: { id: EST_FIELD_TIME }, value: { from: { time: toHHMM(c.from) }, to: { time: toHHMM(c.to) } } },
          ],
        }],
      });
      const resp = result as { keys?: unknown[]; commentId?: unknown };
      const key = Array.isArray(resp.keys) ? resp.keys[0] : undefined;
      if (key === undefined) throw new Error(`Planfix returned an unexpected response shape (no keys): ${jsonFallback(result)}`);
      if (commentId === undefined && typeof resp.commentId === "number") commentId = resp.commentId;
      written.push({ chunk: c, key });
    } catch (err) {
      // Stop immediately — never retry (double-count risk); report exactly
      // what landed. Entries cannot be deleted via the API.
      const notWritten = chunks.slice(i);
      return [
        `add_estimation PARTIALLY FAILED on task ${params.taskId} — stopped at the first write error; writes are NEVER retried automatically (double-count risk).`,
        `Written (${written.length}) — these CANNOT be rolled back (no delete endpoint; correct from the Planfix UI if needed):`,
        ...written.map((w) => `- ${chunkLabel(w.chunk)} → key ${w.key}`),
        `NOT written (${notWritten.length}):`,
        ...notWritten.map((c2) => `- ${chunkLabel(c2)}`),
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      ].join("\n");
    }
  }

  // Read back the summary so an unintended double-add is immediately visible.
  const readBack = await planfixGet(`task/${params.taskId}`, { fields: `id,${ESTIMATION_SUMMARY_FIELD_ID}` });
  const summary = (findArray(asObj(asObj(readBack)?.task) ?? {}, ["customFieldData"]) ?? [])
    .map(asObj)
    .find((e) => asObj(e?.field)?.id === ESTIMATION_SUMMARY_FIELD_ID);
  const total = summary?.stringValue ?? summary?.value ?? "unknown (summary field not returned)";

  return [
    `✓ Estimation added to task ${params.taskId}: ${fmtDur(totalMin)} in ${chunks.length} entr${chunks.length === 1 ? "y" : "ies"}${commentId !== undefined ? `, commentId ${commentId}` : ""}.`,
    ...written.map((w) => `  ${chunkLabel(w.chunk)} → key ${w.key}`),
    `New estimation total on the task (read-back): ${String(total)}. APPEND semantics — if this total is higher than intended, earlier entries also count; correct from the Planfix UI.`,
  ].join("\n");
}
