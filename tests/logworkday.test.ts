import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

const TEST_PROJECT = 572465;
const CYRILLIC = /[а-яА-ЯёЁ]/;

const entry = (taskId: number, timeFrom: string, timeTo: string, comment = "work") =>
  ({ taskId, timeFrom, timeTo, type: "Task" as const, comment });

const excl = (timeFrom: string, timeTo: string, label?: string) => ({ timeFrom, timeTo, label });

const LUNCH = excl("14:00", "15:00", "lunch"); // test fixture — the window is caller-supplied, not a code default

const day = (
  entries: Array<ReturnType<typeof entry>>,
  exclusions: Array<ReturnType<typeof excl>> = [],
  extra: Record<string, unknown> = {},
) => ({ date: "2026-07-24", userId: 403, entries, exclusions, ...extra });

/** Extract the { from, to } clock range a mocked write call sent. */
function sentRange(callIndex: number): { from: string; to: string; endpoint: string } {
  const [endpoint, body] = mockMutate.mock.calls[callIndex] as [string, Record<string, unknown>];
  const items = (body.items as Array<{ customFieldData: Array<{ field: { id: number }; value: unknown }> }>)[0];
  const time = items.customFieldData.find((f) => f.field.id === 185)!.value as { from: { time: string }; to: { time: string } };
  return { from: time.from.time, to: time.to.time, endpoint };
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("log_workday — exclusions are required with no default", () => {
  it("omitting exclusions is a Zod error explaining what to pass and that [] means none", async () => {
    const { logWorkdaySchema } = await import("../src/tools/timeentries.js");
    const parsed = logWorkdaySchema.safeParse({ date: "2026-07-24", userId: 403, entries: [entry(10, "09:00", "10:00")] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const msg = parsed.error.issues.find((i) => i.path[0] === "exclusions")!.message;
      expect(msg).toContain("no default");
      expect(msg).toContain("[]");
      expect(msg).not.toMatch(CYRILLIC);
    }
  });

  it("[] logs straight through a long interval untouched (no cut-outs)", async () => {
    mockMutate.mockResolvedValueOnce({ result: "success", keys: [1], commentId: 500 });
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    const result = await handleLogWorkday(day([entry(10, "12:30", "16:45")], []));
    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(sentRange(0)).toMatchObject({ from: "12:30", to: "16:45" });
    expect(result).toContain("Exclusions: none.");
    expect(result).not.toContain("auto-split");
  });
});

describe("log_workday — happy path", () => {
  it("groups by task and chains commentIds: new comment per task, appends after (call order asserted)", async () => {
    mockMutate
      .mockResolvedValueOnce({ result: "success", keys: [1], commentId: 500 })
      .mockResolvedValueOnce({ result: "success", keys: [2] })
      .mockResolvedValueOnce({ result: "success", keys: [3], commentId: 600 });
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    const result = await handleLogWorkday(day([
      entry(10, "09:00", "11:00"),
      entry(20, "15:00", "16:00"),
      entry(10, "11:00", "12:30"),
    ]));

    expect(mockMutate.mock.calls.map((c) => c[0])).toEqual([
      "task/10/datatags/",
      "task/10/datatags/500",
      "task/20/datatags/",
    ]);
    expect(result).toContain("✓ Workday 2026-07-24 logged for user 403.");
    expect(result).toMatch(/Task 10 — 2 entries, 3h 30m, commentId 500/);
    expect(result).toMatch(/Task 20 — 1 entry, 1h, commentId 600/);
    expect(result).toContain("Day total: 4h 30m across 2 tasks.");
    expect(result).not.toMatch(CYRILLIC);
  });
});

describe("log_workday — exclusion splitting", () => {
  it("splits a window-spanning interval into two chained entries marked with the label", async () => {
    mockMutate
      .mockResolvedValueOnce({ result: "success", keys: [1], commentId: 500 })
      .mockResolvedValueOnce({ result: "success", keys: [2] });
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    const result = await handleLogWorkday(day([entry(10, "12:30", "16:45")], [LUNCH]));

    expect(mockMutate).toHaveBeenCalledTimes(2);
    expect(sentRange(0)).toMatchObject({ from: "12:30", to: "14:00", endpoint: "task/10/datatags/" });
    expect(sentRange(1)).toMatchObject({ from: "15:00", to: "16:45", endpoint: "task/10/datatags/500" });
    expect(result).toContain("Exclusions applied: 14:00-15:00 (lunch).");
    expect(result).toContain("12:30-14:00 (auto-split: lunch)");
    expect(result).toContain("15:00-16:45 (auto-split: lunch)");
    expect(result).toContain("Day total: 3h 15m");
  });

  it("boundary intervals touching a window's edges are legal and not split", async () => {
    mockMutate
      .mockResolvedValueOnce({ result: "success", keys: [1], commentId: 500 })
      .mockResolvedValueOnce({ result: "success", keys: [2] });
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    const result = await handleLogWorkday(day([entry(10, "13:00", "14:00"), entry(10, "15:00", "16:00")], [LUNCH]));
    expect(mockMutate).toHaveBeenCalledTimes(2);
    expect(result).not.toContain("auto-split");
    expect(result).toContain("Day total: 2h");
  });

  it("multi-window: one interval becomes three segments, each marked with its causing window(s)", async () => {
    mockMutate
      .mockResolvedValueOnce({ result: "success", keys: [1], commentId: 500 })
      .mockResolvedValueOnce({ result: "success", keys: [2] })
      .mockResolvedValueOnce({ result: "success", keys: [3] });
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    const result = await handleLogWorkday(day(
      [entry(10, "09:00", "13:00")],
      [excl("10:00", "10:30", "standup"), excl("11:30", "12:00", "call")],
    ));
    expect(mockMutate).toHaveBeenCalledTimes(3);
    expect(sentRange(0)).toMatchObject({ from: "09:00", to: "10:00" });
    expect(sentRange(1)).toMatchObject({ from: "10:30", to: "11:30" });
    expect(sentRange(2)).toMatchObject({ from: "12:00", to: "13:00" });
    expect(result).toContain("09:00-10:00 (auto-split: standup)");
    expect(result).toContain("10:30-11:30 (auto-split: standup, call)");
    expect(result).toContain("12:00-13:00 (auto-split: call)");
    expect(result).toContain("Day total: 3h"); // 4h minus 1h of windows
  });

  it("partial window overlap SPLITS (semantics change vs old refusal): head and tail cases", async () => {
    mockMutate
      .mockResolvedValueOnce({ result: "success", keys: [1], commentId: 500 })
      .mockResolvedValueOnce({ result: "success", keys: [2] });
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    const result = await handleLogWorkday(day(
      [entry(10, "13:30", "14:30"), entry(10, "14:40", "15:30")],
      [LUNCH],
    ));
    expect(mockMutate).toHaveBeenCalledTimes(2);
    expect(sentRange(0)).toMatchObject({ from: "13:30", to: "14:00" });
    expect(sentRange(1)).toMatchObject({ from: "15:00", to: "15:30" });
    expect(result).toContain("13:30-14:00 (auto-split: lunch)");
    expect(result).toContain("15:00-15:30 (auto-split: lunch)");
  });

  it("merges overlapping and adjacent windows before splitting", async () => {
    mockMutate
      .mockResolvedValueOnce({ result: "success", keys: [1], commentId: 500 })
      .mockResolvedValueOnce({ result: "success", keys: [2] });
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    // 12:00-12:30 + 12:15-13:00 overlap; 13:00-13:30 is adjacent → merged 12:00-13:30
    const result = await handleLogWorkday(day(
      [entry(10, "11:00", "14:00")],
      [excl("12:00", "12:30", "lunch"), excl("12:15", "13:00", "call"), excl("13:00", "13:30", "break")],
    ));
    expect(mockMutate).toHaveBeenCalledTimes(2);
    expect(sentRange(0)).toMatchObject({ from: "11:00", to: "12:00" });
    expect(sentRange(1)).toMatchObject({ from: "13:30", to: "14:00" });
    expect(result).toContain("Exclusions applied: 12:00-13:30 (lunch + call + break).");
  });

  it("drops zero-length remainders (interval ending exactly where a window ends)", async () => {
    mockMutate.mockResolvedValueOnce({ result: "success", keys: [1], commentId: 500 });
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    const result = await handleLogWorkday(day([entry(10, "12:00", "15:00")], [LUNCH]));
    expect(mockMutate).toHaveBeenCalledTimes(1); // only 12:00-14:00; the post-window remainder is empty
    expect(sentRange(0)).toMatchObject({ from: "12:00", to: "14:00" });
    expect(result).toContain("Day total: 2h");
  });

  it("an interval entirely inside the exclusion union is rejected, naming the window(s)", async () => {
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    await expect(handleLogWorkday(day([entry(10, "09:00", "10:00"), entry(10, "14:10", "14:50")], [LUNCH])))
      .rejects.toThrow(/entry 2 \(task 10, 14:10-14:50\): lies entirely inside exclusion window\(s\) 14:00-15:00 \(lunch\)/);
    // exactly matching the window is also inside
    await expect(handleLogWorkday(day([entry(10, "14:00", "15:00")], [LUNCH]))).rejects.toThrow(/entirely inside exclusion window/);
    expect(mockMutate).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("rejects a malformed exclusion window (timeFrom >= timeTo)", async () => {
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    await expect(handleLogWorkday(day([entry(10, "09:00", "10:00")], [excl("15:00", "14:00", "backwards")])))
      .rejects.toThrow(/exclusion 1 \(15:00-14:00\): timeFrom must be earlier than timeTo/);
    expect(mockMutate).not.toHaveBeenCalled();
  });
});

describe("log_workday — validation refusals (whole day, nothing written)", () => {
  it("rejects timeFrom >= timeTo, naming the entry", async () => {
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    await expect(handleLogWorkday(day([entry(10, "11:00", "10:00")])))
      .rejects.toThrow(/entry 1 \(task 10, 11:00-10:00\): timeFrom must be earlier than timeTo/);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("rejects overlapping intervals across tasks", async () => {
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    await expect(handleLogWorkday(day([entry(10, "09:00", "11:00"), entry(20, "10:30", "12:00")])))
      .rejects.toThrow(/entries 1 and 2 overlap/);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("rejects post-split collisions (split tail vs another entry)", async () => {
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    // 12:00-16:00 splits around lunch to 12:00-14:00 + 15:00-16:00; the tail collides with 15:30-17:00
    await expect(handleLogWorkday(day([entry(10, "12:00", "16:00"), entry(20, "15:30", "17:00")], [LUNCH])))
      .rejects.toThrow(/overlap after exclusion-splitting: 15:00-16:00 \(auto-split: lunch\) vs 15:30-17:00/);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("lists ALL violations in one refusal, in English", async () => {
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    const err = await handleLogWorkday(day([entry(10, "11:00", "10:00"), entry(10, "14:15", "14:45")], [LUNCH])).then(
      () => { throw new Error("expected refusal"); },
      (e: Error) => e,
    );
    expect(err.message).toContain("NOTHING was written");
    expect(err.message).toContain("entry 1");
    expect(err.message).toContain("entry 2");
    expect(err.message).not.toMatch(CYRILLIC);
  });
});

describe("log_workday — validate_only", () => {
  it("returns the resolved post-split plan with applied windows and totals; ZERO HTTP calls", async () => {
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    const result = await handleLogWorkday(day(
      [entry(10, "12:30", "16:45"), entry(20, "09:00", "10:00")],
      [LUNCH],
      { validate_only: true },
    ));
    expect(mockMutate).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(result).toContain("NOTHING written (validate_only)");
    expect(result).toContain("Exclusions applied: 14:00-15:00 (lunch).");
    expect(result).toContain("12:30-14:00 (auto-split: lunch)");
    expect(result).toContain("15:00-16:45 (auto-split: lunch)");
    expect(result).toMatch(/Task 10 — 2 entries, 3h 15m/);
    expect(result).toMatch(/Task 20 — 1 entry, 1h/);
    expect(result).toContain("Day total: 4h 15m across 2 tasks.");
    expect(result).toContain("call log_workday again without validate_only");
    expect(result).not.toMatch(CYRILLIC);
  });
});

describe("log_workday — partial failure", () => {
  it("stops at the first write error, reports written vs not-written, no retry, no rollback claim", async () => {
    mockMutate
      .mockResolvedValueOnce({ result: "success", keys: [1], commentId: 500 })
      .mockRejectedValueOnce(new Error("Planfix HTTP 502: Bad Gateway"));
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    const result = await handleLogWorkday(day([
      entry(10, "09:00", "10:00"),
      entry(10, "10:00", "11:00"),
      entry(20, "15:00", "16:00"),
    ]));

    expect(mockMutate).toHaveBeenCalledTimes(2);
    expect(result).toContain("PARTIALLY FAILED");
    expect(result).toContain("Written (1)");
    expect(result).toContain("- task 10: 09:00-10:00 → key 1, commentId 500");
    expect(result).toContain("CANNOT be rolled back");
    expect(result).toContain("NOT written (2)");
    expect(result).toContain("- task 10: 10:00-11:00");
    expect(result).toContain("- task 20: 15:00-16:00");
    expect(result).toContain("Error: Planfix HTTP 502: Bad Gateway");
    expect(result).toContain("NEVER retried");
    expect(result).not.toMatch(CYRILLIC);
  });
});

describe("log_workday — safe mode", () => {
  it("ON: every task is verified upfront; a task outside MCP-Test refuses BEFORE any write", async () => {
    vi.stubEnv("PLANFIX_SAFE_MODE", "1");
    vi.stubEnv("PLANFIX_TEST_PROJECT_ID", String(TEST_PROJECT));
    mockGet.mockImplementation(async (endpoint: string) =>
      endpoint.startsWith("task/10")
        ? { task: { id: 10, project: { id: TEST_PROJECT } } }
        : { task: { id: 20, project: { id: 111 } } });
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    await expect(handleLogWorkday(day([entry(10, "09:00", "10:00"), entry(20, "10:00", "11:00")])))
      .rejects.toThrow(/log_workday refused.*task 20.*111.*572465/s);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("ON: all tasks inside MCP-Test → writes proceed", async () => {
    vi.stubEnv("PLANFIX_SAFE_MODE", "1");
    vi.stubEnv("PLANFIX_TEST_PROJECT_ID", String(TEST_PROJECT));
    mockGet.mockResolvedValue({ task: { id: 10, project: { id: TEST_PROJECT } } });
    mockMutate.mockResolvedValue({ result: "success", keys: [1], commentId: 500 });
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    const result = await handleLogWorkday(day([entry(10, "09:00", "10:00")]));
    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(result).toContain("✓ Workday");
  });

  it("ON without a test project id: fail-closed before any HTTP", async () => {
    vi.stubEnv("PLANFIX_SAFE_MODE", "1");
    vi.stubEnv("PLANFIX_TEST_PROJECT_ID", "");
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    await expect(handleLogWorkday(day([entry(10, "09:00", "10:00")])))
      .rejects.toThrow(/PLANFIX_TEST_PROJECT_ID is unset or not a positive integer/);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockMutate).not.toHaveBeenCalled();
  });
});
