// ROADMAP P10: get_time_report — cross-task per-person workload & unlogged days.
// Request/response shapes mirror the live spike evidence (docs/spikes/time-report.md).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/client.js", () => ({
  planfixPost: vi.fn(),
  planfixGet: vi.fn(),
  planfixMutate: vi.fn(),
  planfixUploadFile: vi.fn(),
}));

import { planfixPost, planfixMutate } from "../src/client.js";

const mockPost = vi.mocked(planfixPost);
const mockMutate = vi.mocked(planfixMutate);

const CYRILLIC = /[а-яА-ЯёЁ]/;

/** Build an entry as the API returns it (raw shape from the spike). */
function entry(userId: number, name: string, dmyDate: string, durationSec: number) {
  return {
    key: 1000 + Math.floor(durationSec / 60),
    customFieldData: [
      { field: { id: 173 }, value: [{ id: `user:${userId}`, name }], stringValue: name },
      { field: { id: 175 }, value: { date: dmyDate }, stringValue: dmyDate },
      { field: { id: 185 }, value: { from: { time: "10:00" }, to: { time: "18:00" }, durationSec }, stringValue: "10:00 - 18:00" },
    ],
  };
}

describe("get_time_report", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("sends the spike-verified filter shape per user (3103/173 + 3101/175 otherRange)", async () => {
    mockPost.mockResolvedValue({ dataTagEntries: [] });
    const { handleGetTimeReport } = await import("../src/tools/timeentries.js");
    await handleGetTimeReport({ userIds: [403, 312], dateFrom: "2026-07-01", dateTo: "2026-07-31" });
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockPost).toHaveBeenNthCalledWith(1, "datatag/59/entry/list", {
      offset: 0,
      pageSize: 100,
      fields: "key,173,175,185",
      filters: [
        { type: 3103, field: 173, operator: "equal", value: "user:403" },
        { type: 3101, field: 175, operator: "equal", value: { dateType: "otherRange", dateFrom: "01-07-2026", dateTo: "31-07-2026" } },
      ],
    });
    expect(mockPost).toHaveBeenNthCalledWith(2, "datatag/59/entry/list", expect.objectContaining({
      filters: expect.arrayContaining([expect.objectContaining({ value: "user:312" })]),
    }));
  });

  it("aggregates per-day totals, resolves the display name, lists unlogged Mon-Fri days with the definition verbatim", async () => {
    // Week 2026-07-06 (Mon) .. 2026-07-12 (Sun): entries Mon+Tue only.
    mockPost.mockResolvedValue({ dataTagEntries: [
      entry(403, "Dmytro Galogen Halahan", "06-07-2026", 3 * 3600),
      entry(403, "Dmytro Galogen Halahan", "06-07-2026", 90 * 60),
      entry(403, "Dmytro Galogen Halahan", "07-07-2026", 2 * 3600),
    ] });
    const { handleGetTimeReport } = await import("../src/tools/timeentries.js");
    const out = await handleGetTimeReport({ userIds: [403], dateFrom: "2026-07-06", dateTo: "2026-07-12" });

    expect(out).toContain("Time report 2026-07-06..2026-07-12 (7 days, 1 user).");
    expect(out).toContain("Unlogged = Mon-Fri days in range with zero entries.");
    expect(out).toContain("user:403 Dmytro Galogen Halahan — total 6h 30m across 2 days (3 entries):");
    expect(out).toContain("  2026-07-06: 4h 30m (2 entries)");
    expect(out).toContain("  2026-07-07: 2h (1 entry)");
    // Wed-Fri unlogged; Sat-Sun are not working days.
    expect(out).toContain("Unlogged days (3 of 5): 2026-07-08, 2026-07-09, 2026-07-10");
    expect(out).not.toContain("2026-07-11"); // Saturday never counts as unlogged
    expect(out).not.toMatch(CYRILLIC);
  });

  it("workingDays override changes the candidates and the stated definition; outside dates refuse", async () => {
    mockPost.mockResolvedValue({ dataTagEntries: [entry(403, "G", "06-07-2026", 3600)] });
    const { handleGetTimeReport } = await import("../src/tools/timeentries.js");
    const out = await handleGetTimeReport({
      userIds: [403], dateFrom: "2026-07-06", dateTo: "2026-07-12",
      workingDays: ["2026-07-06", "2026-07-11"], // includes a Saturday — caller's call
    });
    expect(out).toContain("Unlogged = the 2 caller-provided workingDays with zero entries.");
    expect(out).toContain("Unlogged days (1 of 2): 2026-07-11");

    await expect(handleGetTimeReport({
      userIds: [403], dateFrom: "2026-07-06", dateTo: "2026-07-12",
      workingDays: ["2026-08-01"],
    })).rejects.toThrow("workingDays must lie inside 2026-07-06..2026-07-12; outside: 2026-08-01");
  });

  it("a zero-entry user renders explicitly and every working day counts as unlogged", async () => {
    mockPost.mockResolvedValue({ dataTagEntries: [] });
    const { handleGetTimeReport } = await import("../src/tools/timeentries.js");
    const out = await handleGetTimeReport({ userIds: [999], dateFrom: "2026-07-06", dateTo: "2026-07-10" });
    expect(out).toContain("user:999 — no entries in range.");
    expect(out).toContain("Unlogged days (5 of 5): all working days in range.");
  });

  it("pages per user and stops at the 10-page scan cap with the N+ convention", async () => {
    // Every page full (100 entries) → cap after 10 pages.
    mockPost.mockImplementation(async (_ep, body) => {
      const b = body as { offset: number };
      return { dataTagEntries: Array.from({ length: 100 }, (_, i) =>
        entry(403, "G", "06-07-2026", 60 + b.offset + i)) };
    });
    const { handleGetTimeReport } = await import("../src/tools/timeentries.js");
    const out = await handleGetTimeReport({ userIds: [403], dateFrom: "2026-07-06", dateTo: "2026-07-10" });
    expect(mockPost).toHaveBeenCalledTimes(10);
    expect(mockPost).toHaveBeenLastCalledWith("datatag/59/entry/list", expect.objectContaining({ offset: 900 }));
    expect(out).toMatch(/total .*\+ across 1\+ days \(1000\+ entries\)/);
    expect(out).toContain("scan cap reached at 1000 entries — totals are lower bounds");
  });

  it("stops paging early when a page comes back short", async () => {
    mockPost
      .mockResolvedValueOnce({ dataTagEntries: Array.from({ length: 100 }, () => entry(403, "G", "06-07-2026", 60)) })
      .mockResolvedValueOnce({ dataTagEntries: [entry(403, "G", "07-07-2026", 60)] });
    const { handleGetTimeReport } = await import("../src/tools/timeentries.js");
    const out = await handleGetTimeReport({ userIds: [403], dateFrom: "2026-07-06", dateTo: "2026-07-10" });
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(out).toContain("(101 entries)");
    expect(out).not.toContain("scan cap");
  });

  it("refuses ranges over 92 days and inverted ranges, naming the problem", async () => {
    const { handleGetTimeReport } = await import("../src/tools/timeentries.js");
    await expect(handleGetTimeReport({ userIds: [403], dateFrom: "2026-01-01", dateTo: "2026-06-30" }))
      .rejects.toThrow(/spans 181 days.*capped at 92 days/);
    await expect(handleGetTimeReport({ userIds: [403], dateFrom: "2026-07-10", dateTo: "2026-07-01" }))
      .rejects.toThrow("dateFrom (2026-07-10) must not be after dateTo (2026-07-01)");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("accepts exactly 92 days", async () => {
    mockPost.mockResolvedValue({ dataTagEntries: [] });
    const { handleGetTimeReport } = await import("../src/tools/timeentries.js");
    const out = await handleGetTimeReport({ userIds: [403], dateFrom: "2026-01-01", dateTo: "2026-04-02" });
    expect(out).toContain("(92 days, 1 user)");
  });

  it("schema rejects empty/oversized userIds and malformed dates", async () => {
    const { getTimeReportSchema } = await import("../src/tools/timeentries.js");
    expect(getTimeReportSchema.safeParse({ userIds: [], dateFrom: "2026-07-01", dateTo: "2026-07-31" }).success).toBe(false);
    expect(getTimeReportSchema.safeParse({ userIds: Array.from({ length: 11 }, (_, i) => i + 1), dateFrom: "2026-07-01", dateTo: "2026-07-31" }).success).toBe(false);
    expect(getTimeReportSchema.safeParse({ userIds: [403], dateFrom: "01-07-2026", dateTo: "2026-07-31" }).success).toBe(false);
    expect(getTimeReportSchema.safeParse({ userIds: [403], dateFrom: "2026-07-01", dateTo: "2026-07-31", workingDays: ["07/07/2026"] }).success).toBe(false);
    expect(getTimeReportSchema.safeParse({ userIds: [403], dateFrom: "2026-07-01", dateTo: "2026-07-31" }).success).toBe(true);
  });

  it("propagates API failure", async () => {
    mockPost.mockRejectedValue(new Error("Planfix API error 22: rate limit"));
    const { handleGetTimeReport } = await import("../src/tools/timeentries.js");
    await expect(handleGetTimeReport({ userIds: [403], dateFrom: "2026-07-01", dateTo: "2026-07-31" }))
      .rejects.toThrow("rate limit");
  });

  it("user names are DATA — a Cyrillic name passes through while templates stay English", async () => {
    mockPost.mockResolvedValue({ dataTagEntries: [entry(310, "Олена Magura Тарнавська", "06-07-2026", 3600)] });
    const { handleGetTimeReport } = await import("../src/tools/timeentries.js");
    const out = await handleGetTimeReport({ userIds: [310], dateFrom: "2026-07-06", dateTo: "2026-07-06" });
    expect(out).toContain("user:310 Олена Magura Тарнавська — total 1h across 1 day (1 entry):");
    const templateOnly = out.replace(/Олена Magura Тарнавська/g, "");
    expect(templateOnly).not.toMatch(CYRILLIC);
  });
});
