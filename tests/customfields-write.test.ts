// ROADMAP P9 Part B: set_task_custom_field + add_estimation.
// Shapes mirror the live spike evidence (docs/spikes/task-custom-fields.md).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/client.js", () => ({
  planfixPost: vi.fn(),
  planfixGet: vi.fn(),
  planfixMutate: vi.fn(),
  planfixUploadFile: vi.fn(),
}));

import { planfixPost, planfixGet, planfixMutate } from "../src/client.js";

const mockPost = vi.mocked(planfixPost);
const mockMutate = vi.mocked(planfixMutate);
const mockGet = vi.mocked(planfixGet);

const CYRILLIC = /[а-яА-ЯёЁ]/;

const FIELD_LIST = { customfields: [
  { id: 22571, name: "[RevOps] Sprint", type: 8, enumValues: ["Sprint 4 - 2026", "Sprint 10 - 2026"] },
  { id: 22453, name: "Estimation RevOps", type: 23 },
  { id: 21762, name: "Some date", type: 5 },
  { id: 30000, name: "Freeform list", type: 8 }, // List without enumValues
] };

// ── set_task_custom_field ─────────────────────────────────────────────────────

describe("set_task_custom_field", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  function mockLookupAndReadback(stored?: { value?: unknown; stringValue?: unknown }) {
    mockGet.mockImplementation(async (ep) => {
      if (String(ep).startsWith("customfield/task")) return FIELD_LIST;
      return { task: { id: 123, customFieldData: stored ? [{ field: { id: 22571 }, ...stored }] : [] } };
    });
  }

  it("happy path: validates, writes, verifies by read-back", async () => {
    mockLookupAndReadback({ value: "Sprint 10 - 2026", stringValue: "Sprint 10 - 2026" });
    mockMutate.mockResolvedValue({ result: "success" });
    const { handleSetTaskCustomField } = await import("../src/tools/customfields.js");
    const out = await handleSetTaskCustomField({ taskId: 123, fieldId: 22571, value: "Sprint 10 - 2026" });
    expect(mockMutate).toHaveBeenCalledWith("task/123", {
      customFieldData: [{ field: { id: 22571 }, value: "Sprint 10 - 2026" }],
    });
    expect(mockGet).toHaveBeenCalledWith("task/123", { fields: "id,22571" });
    expect(out).toContain("✓");
    expect(out).toContain("verified by read-back");
  });

  it("refuses a value outside enumValues BEFORE writing, listing the options", async () => {
    mockLookupAndReadback();
    const { handleSetTaskCustomField } = await import("../src/tools/customfields.js");
    const err = await handleSetTaskCustomField({ taskId: 123, fieldId: 22571, value: "Sprint 99 - 2099" }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("not an allowed value");
    expect((err as Error).message).toContain("Sprint 10 - 2026");
    expect((err as Error).message).not.toMatch(CYRILLIC);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("refuses unknown field ids with a list_custom_fields pointer", async () => {
    mockLookupAndReadback();
    const { handleSetTaskCustomField } = await import("../src/tools/customfields.js");
    await expect(handleSetTaskCustomField({ taskId: 123, fieldId: 99999, value: "x" }))
      .rejects.toThrow(/Unknown task custom field id 99999.*list_custom_fields/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("refuses Data tag summary fields, pointing at add_estimation/add_time_entry", async () => {
    mockLookupAndReadback();
    const { handleSetTaskCustomField } = await import("../src/tools/customfields.js");
    await expect(handleSetTaskCustomField({ taskId: 123, fieldId: 22453, value: "30" }))
      .rejects.toThrow(/Data tag summary.*add_estimation/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("refuses non-List field types", async () => {
    mockLookupAndReadback();
    const { handleSetTaskCustomField } = await import("../src/tools/customfields.js");
    await expect(handleSetTaskCustomField({ taskId: 123, fieldId: 21762, value: "x" }))
      .rejects.toThrow(/type 5.*List fields/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("a List field without enumValues skips enum validation but still verifies read-back", async () => {
    mockGet.mockImplementation(async (ep) => {
      if (String(ep).startsWith("customfield/task")) return FIELD_LIST;
      return { task: { id: 123, customFieldData: [{ field: { id: 30000 }, value: "anything", stringValue: "anything" }] } };
    });
    mockPost.mockResolvedValue({ result: "success" });
    const { handleSetTaskCustomField } = await import("../src/tools/customfields.js");
    const out = await handleSetTaskCustomField({ taskId: 123, fieldId: 30000, value: "anything" });
    expect(out).toContain("✓");
  });

  it("template-attachment silent no-op becomes an actionable error (write ok, read-back empty)", async () => {
    mockLookupAndReadback(undefined); // read-back returns no customFieldData
    mockPost.mockResolvedValue({ result: "success" }); // the API lies
    const { handleSetTaskCustomField } = await import("../src/tools/customfields.js");
    const err = await handleSetTaskCustomField({ taskId: 123, fieldId: 22571, value: "Sprint 10 - 2026" }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("did NOT persist");
    expect((err as Error).message).toContain("template");
  });

  it("schema rejects an empty value", async () => {
    const { setTaskCustomFieldSchema } = await import("../src/tools/customfields.js");
    expect(setTaskCustomFieldSchema.safeParse({ taskId: 1, fieldId: 2, value: "" }).success).toBe(false);
    expect(setTaskCustomFieldSchema.safeParse({ taskId: 1, fieldId: 2, value: "x" }).success).toBe(true);
  });

  it("propagates API failure from the lookup leg", async () => {
    mockGet.mockRejectedValue(new Error("Planfix API error 22: rate limit"));
    const { handleSetTaskCustomField } = await import("../src/tools/customfields.js");
    await expect(handleSetTaskCustomField({ taskId: 123, fieldId: 22571, value: "x" })).rejects.toThrow("rate limit");
    expect(mockPost).not.toHaveBeenCalled();
  });
});

// ── add_estimation ────────────────────────────────────────────────────────────

describe("add_estimation", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const SUMMARY = { task: { id: 123, customFieldData: [{ field: { id: 22453 }, value: 630, stringValue: "10 ч 30 мин" }] } };

  it("review example: 10.5h over workday 10:00-19:00 excl 14:00-15:00 → 4h + 4h + 2.5h", async () => {
    const { handleAddEstimation } = await import("../src/tools/customfields.js");
    const plan = await handleAddEstimation({
      taskId: 123, userId: 403, hours: 10.5,
      workday: { from: "10:00", to: "19:00", exclusions: [{ timeFrom: "14:00", timeTo: "15:00" }] },
      validate_only: true,
    });
    expect(plan).toContain("NOTHING written");
    expect(plan).toContain("1. 10:00-14:00 (4h)");
    expect(plan).toContain("2. 15:00-19:00 (4h)");
    expect(plan).toContain("3. 10:00-12:30 (2h 30m)");
    expect(plan).toContain("2 visual days");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("no workday: plain maximal chunks 00:00-24:00 + remainder", async () => {
    const { handleAddEstimation } = await import("../src/tools/customfields.js");
    const plan = await handleAddEstimation({ taskId: 123, userId: 403, hours: 30, validate_only: true });
    expect(plan).toContain("1. 00:00-24:00 (24h)");
    expect(plan).toContain("2. 00:00-06:00 (6h)");
  });

  it("writes chunks with the from/to shape ONLY, chains onto one comment, reports the new total", async () => {
    mockMutate
      .mockResolvedValueOnce({ result: "success", keys: [127901], commentId: 47886313 })
      .mockResolvedValueOnce({ result: "success", keys: [127905] });
    mockGet.mockResolvedValue(SUMMARY);
    const { handleAddEstimation } = await import("../src/tools/customfields.js");
    const out = await handleAddEstimation({ taskId: 123, userId: 403, hours: 30 });

    expect(mockMutate).toHaveBeenNthCalledWith(1, "task/123/datatags/", {
      dataTag: { id: 61 },
      items: [{ customFieldData: [
        { field: { id: 187 }, value: [{ id: "user:403" }] },
        { field: { id: 189 }, value: { from: { time: "00:00" }, to: { time: "24:00" } } },
      ] }],
    });
    // second entry chains onto the comment returned by the first
    expect(mockMutate).toHaveBeenNthCalledWith(2, "task/123/datatags/47886313", expect.objectContaining({ dataTag: { id: 61 } }));
    // durationSec must never appear in any write body (proven silent no-op)
    for (const [, body] of mockMutate.mock.calls) {
      expect(JSON.stringify(body)).not.toContain("durationSec");
    }
    expect(mockGet).toHaveBeenCalledWith("task/123", { fields: "id,22453" });
    expect(out).toContain("✓");
    expect(out).toContain("10 ч 30 мин"); // read-back total (data passes through)
    expect(out).toContain("APPEND");
  });

  it("refuses sub-minute hours and zero", async () => {
    const { handleAddEstimation } = await import("../src/tools/customfields.js");
    await expect(handleAddEstimation({ taskId: 1, userId: 403, hours: 1.001 })).rejects.toThrow("whole number of minutes");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("refuses invalid workday layouts all-or-nothing (violations listed, zero writes)", async () => {
    const { handleAddEstimation } = await import("../src/tools/customfields.js");
    const err = await handleAddEstimation({
      taskId: 1, userId: 403, hours: 2,
      workday: { from: "19:00", to: "10:00", exclusions: [{ timeFrom: "09:00", timeTo: "08:00" }] },
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("NOTHING was written");
    expect((err as Error).message).toContain("workday 19:00-10:00");
    expect((err as Error).message).toContain("exclusion 1");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("refuses exclusions outside the workday window and full-coverage exclusions", async () => {
    const { handleAddEstimation } = await import("../src/tools/customfields.js");
    await expect(handleAddEstimation({
      taskId: 1, userId: 403, hours: 2,
      workday: { from: "10:00", to: "12:00", exclusions: [{ timeFrom: "09:00", timeTo: "11:00" }] },
    })).rejects.toThrow("inside the workday");
    await expect(handleAddEstimation({
      taskId: 1, userId: 403, hours: 2,
      workday: { from: "10:00", to: "12:00", exclusions: [{ timeFrom: "10:00", timeTo: "12:00" }] },
    })).rejects.toThrow("cover the whole workday");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("mid-sequence write failure stops, never retries, and reports landed vs not-landed exactly", async () => {
    mockMutate
      .mockResolvedValueOnce({ result: "success", keys: [200], commentId: 900 })
      .mockRejectedValueOnce(new Error("Planfix HTTP 500"));
    const { handleAddEstimation } = await import("../src/tools/customfields.js");
    const out = await handleAddEstimation({ taskId: 123, userId: 403, hours: 30 });
    expect(out).toContain("PARTIALLY FAILED");
    expect(out).toContain("Written (1)");
    expect(out).toContain("00:00-24:00 (24h) → key 200");
    expect(out).toContain("NOT written (1)");
    expect(out).toContain("00:00-06:00 (6h)");
    expect(out).toContain("Planfix HTTP 500");
    expect(mockMutate).toHaveBeenCalledTimes(2);
  });

  it("schema: workday.exclusions is required inside workday (no default), [] allowed", async () => {
    const { addEstimationSchema } = await import("../src/tools/customfields.js");
    expect(addEstimationSchema.safeParse({ taskId: 1, userId: 403, hours: 2, workday: { from: "10:00", to: "19:00" } }).success).toBe(false);
    expect(addEstimationSchema.safeParse({ taskId: 1, userId: 403, hours: 2, workday: { from: "10:00", to: "19:00", exclusions: [] } }).success).toBe(true);
    expect(addEstimationSchema.safeParse({ taskId: 1, userId: 403, hours: 0 }).success).toBe(false);
    expect(addEstimationSchema.safeParse({ taskId: 1, userId: 403, hours: 2, workday: { from: "24:00", to: "19:00", exclusions: [] } }).success).toBe(false);
  });

  it("adjacent/overlapping exclusions merge before layout", async () => {
    const { handleAddEstimation } = await import("../src/tools/customfields.js");
    const plan = await handleAddEstimation({
      taskId: 1, userId: 403, hours: 4,
      workday: { from: "10:00", to: "16:00", exclusions: [{ timeFrom: "12:00", timeTo: "13:00" }, { timeFrom: "13:00", timeTo: "14:00" }] },
      validate_only: true,
    });
    expect(plan).toContain("1. 10:00-12:00 (2h)");
    expect(plan).toContain("2. 14:00-16:00 (2h)");
  });
});
