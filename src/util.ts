// Shared helpers consolidated by the P13 audit (docs/audit-2026-07.md,
// findings D1/D2/D4/D6) — every function here replaced byte-identical copies
// that lived in two or more src/tools/* files.

import { z } from "zod";

// ── Object shims (D1) ─────────────────────────────────────────────────────────
// Defined HERE as the dependency base; src/format.ts re-exports them for its
// existing importers (util must not import from format — format uses fmtDur).

export type Json = Record<string, unknown>;

/** Narrow an unknown to a plain object. */
export function obj(v: unknown): Json | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
}

/** Find the entity array in a response: preferred keys first, then the first array found. */
export function findArray(resp: unknown, keys: string[]): unknown[] | undefined {
  const o = obj(resp);
  if (!o) return undefined;
  for (const k of keys) if (Array.isArray(o[k])) return o[k] as unknown[];
  for (const v of Object.values(o)) if (Array.isArray(v)) return v as unknown[];
  return undefined;
}

// ── HH:MM clock helpers (D2) ──────────────────────────────────────────────────

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/**
 * 1440 renders as "24:00" — the only place a non-HH:MM boundary is valid:
 * it is the working 24h estimation-chunk shape (docs/spikes/task-custom-fields.md,
 * addendum — `00:00-00:00` stores a durationSec the summary field IGNORES).
 */
export const toHHMM = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** Compact duration: "2h 30m", "2h" (zero minutes omitted), "45m". */
export const fmtDur = (min: number): string => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
};

// ── ISO dates (D6) ────────────────────────────────────────────────────────────

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Zod schema for an ISO YYYY-MM-DD field. `label`/`example` parametrize the
 * refusal message so the historical per-field texts stay byte-identical.
 */
export const isoDate = (label: string, example?: string): z.ZodString =>
  z.string().regex(
    ISO_DATE,
    `${label} must be an ISO date in YYYY-MM-DD format${example ? `, e.g. ${example}` : ""}`,
  );

/** ISO "YYYY-MM-DD" → Planfix "DD-MM-YYYY". */
export const isoToPlanfixDate = (iso: string): string => {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
};

// ── customFieldData read-back extraction (D4) ─────────────────────────────────

/**
 * Pick one customFieldData entry off a task response (`{task: {customFieldData}}`
 * or a bare task object) by custom field id — the read-back-verification step
 * of the custom-field write tools.
 */
export function findCustomFieldEntry(resp: unknown, fieldId: number): Json | undefined {
  const task = obj(obj(resp)?.task) ?? obj(resp) ?? {};
  return (findArray(task, ["customFieldData"]) ?? [])
    .map(obj)
    .find((e) => obj(e?.field)?.id === fieldId);
}
