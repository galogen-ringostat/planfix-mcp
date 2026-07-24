import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/client.js", () => ({
  planfixPost: vi.fn(),
  planfixGet: vi.fn(),
}));

import { planfixPost, planfixGet } from "../src/client.js";

const mockPost = vi.mocked(planfixPost);
const mockGet = vi.mocked(planfixGet);

const TEST_PROJECT = 572465;
const CYRILLIC = /[а-яА-ЯёЁ]/;

const entry = (taskId: number, timeFrom: string, timeTo: string, comment = "work") =>
  ({ taskId, timeFrom, timeTo, type: "Task" as const, comment });

const day = (entries: Array<ReturnType<typeof entry>>, extra: Record<string, unknown> = {}) =>
  ({ date: "2026-07-24", userId: 403, entries, ...extra });

/** Extract the { from, to } clock range a mocked write call sent. */
function sentRange(callIndex: number): { from: string; to: string; endpoint: string } {
  const [endpoint, body] = mockPost.mock.calls[callIndex] as [string, Record<string, unknown>];
  const items = (body.items as Array<{ customFieldData: Array<{ field: { id: number }; value: unknown }> }>)[0];
  const time = items.customFieldData.find((f) => f.field.id === 185)!.value as { from: { time: string }; to: { time: string } };
  return { from: time.from.time, to: time.to.time, endpoint };
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("log_workday — happy path", () => {
  it("groups by task and chains commentIds: new comment per task, appends after (call order asserted)", async () => {
    mockPost
      .mockResolvedValueOnce({ result: "success", keys: [1], commentId: 500 }) // task 10, first (new comment)
      .mockResolvedValueOnce({ result: "success", keys: [2] })                 // task 10, append (no commentId in resp)
      .mockResolvedValueOnce({ result: "success", keys: [3], commentId: 600 }); // task 20, first
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    const result = await handleLogWorkday(day([
      entry(10, "09:00", "11:00"),
      entry(20, "15:00", "16:00"),
      entry(10, "11:00", "12:30"),
    ]));

    expect(mockPost.mock.calls.map((c) => c[0])).toEqual([
      "task/10/datatags/",    // task 10 first entry opens the comment
      "task/10/datatags/500", // task 10 second entry chains onto it
      "task/20/datatags/",    // task 20 opens its own comment
    ]);
    expect(result).toContain("✓ Workday 2026-07-24 logged for user 403.");
    expect(result).toMatch(/Task 10 — 2 entries, 3h 30m, commentId 500/);
    expect(result).toMatch(/Task 20 — 1 entry, 1h, commentId 600/);
    expect(result).toContain("key 1");
    expect(result).toContain("key 2");
    expect(result).toContain("key 3");
    expect(result).toContain("Day total: 4h 30m across 2 tasks.");
    expect(result).not.toMatch(CYRILLIC);
  });
});

describe("log_workday — lunch rule", () => {
  it("auto-splits a lunch-spanning interval into two chained entries", async () => {
    mockPost
      .mockResolvedValueOnce({ result: "success", keys: [1], commentId: 500 })
      .mockResolvedValueOnce({ result: "success", keys: [2] });
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    const result = await handleLogWorkday(day([entry(10, "12:30", "16:45")]));

    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(sentRange(0)).toMatchObject({ from: "12:30", to: "14:00", endpoint: "task/10/datatags/" });
    expect(sentRange(1)).toMatchObject({ from: "15:00", to: "16:45", endpoint: "task/10/datatags/500" });
    expect(result).toContain("12:30-14:00 (auto-split)");
    expect(result).toContain("15:00-16:45 (auto-split)");
    expect(result).toContain("Day total: 3h 15m"); // 1h30m + 1h45m — lunch hour excluded
  });

  it("boundary intervals ending 14:00 or starting 15:00 are legal and not split", async () => {
    mockPost
      .mockResolvedValueOnce({ result: "success", keys: [1], commentId: 500 })
      .mockResolvedValueOnce({ result: "success", keys: [2] });
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    const result = await handleLogWorkday(day([entry(10, "13:00", "14:00"), entry(10, "15:00", "16:00")]));
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(result).not.toContain("auto-split");
    expect(result).toContain("Day total: 2h");
  });

  it("an interval inside the lunch break is rejected, nothing written", async () => {
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    await expect(handleLogWorkday(day([entry(10, "09:00", "10:00"), entry(10, "14:10", "14:50")])))
      .rejects.toThrow(/entry 2 \(task 10, 14:10-14:50\): lies entirely inside the 14:00-15:00 lunch break/);
    // exactly 14:00-15:00 is also "inside"
    await expect(handleLogWorkday(day([entry(10, "14:00", "15:00")]))).rejects.toThrow(/inside the 14:00-15:00 lunch break/);
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("an interval partially overlapping lunch is rejected (no silent truncation)", async () => {
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    await expect(handleLogWorkday(day([entry(10, "13:30", "14:30")])))
      .rejects.toThrow(/partially overlaps the 14:00-15:00 lunch break/);
    await expect(handleLogWorkday(day([entry(10, "14:30", "15:30")])))
      .rejects.toThrow(/partially overlaps/);
    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe("log_workday — validation refusals (whole day, nothing written)", () => {
  it("rejects timeFrom >= timeTo, naming the entry", async () => {
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    await expect(handleLogWorkday(day([entry(10, "11:00", "10:00")])))
      .rejects.toThrow(/entry 1 \(task 10, 11:00-10:00\): timeFrom must be earlier than timeTo/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("rejects overlapping intervals across tasks", async () => {
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    await expect(handleLogWorkday(day([entry(10, "09:00", "11:00"), entry(20, "10:30", "12:00")])))
      .rejects.toThrow(/entries 1 and 2 overlap/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("rejects post-split collisions (lunch-split tail vs another entry)", async () => {
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    // 12:00-16:00 splits to 12:00-14:00 + 15:00-16:00; the tail collides with 15:30-17:00
    await expect(handleLogWorkday(day([entry(10, "12:00", "16:00"), entry(20, "15:30", "17:00")])))
      .rejects.toThrow(/overlap after lunch-splitting: 15:00-16:00 \(auto-split\) vs 15:30-17:00/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("lists ALL violations in one refusal, in English", async () => {
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    const err = await handleLogWorkday(day([entry(10, "11:00", "10:00"), entry(10, "14:15", "14:45")])).then(
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
  it("returns the resolved post-split plan with totals and issues ZERO HTTP calls", async () => {
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    const result = await handleLogWorkday(day(
      [entry(10, "12:30", "16:45"), entry(20, "09:00", "10:00")],
      { validate_only: true },
    ));
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(result).toContain("NOTHING written (validate_only)");
    expect(result).toContain("12:30-14:00 (auto-split)");
    expect(result).toContain("15:00-16:45 (auto-split)");
    expect(result).toMatch(/Task 10 — 2 entries, 3h 15m/);
    expect(result).toMatch(/Task 20 — 1 entry, 1h/);
    expect(result).toContain("Day total: 4h 15m across 2 tasks.");
    expect(result).toContain("call log_workday again without validate_only");
    expect(result).not.toMatch(CYRILLIC);
  });
});

describe("log_workday — partial failure", () => {
  it("stops at the first write error, reports written vs not-written, no retry, no rollback claim", async () => {
    mockPost
      .mockResolvedValueOnce({ result: "success", keys: [1], commentId: 500 }) // task 10 entry 1 OK
      .mockRejectedValueOnce(new Error("Planfix HTTP 502: Bad Gateway"));      // task 10 entry 2 fails
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    const result = await handleLogWorkday(day([
      entry(10, "09:00", "10:00"),
      entry(10, "10:00", "11:00"),
      entry(20, "15:00", "16:00"),
    ]));

    expect(mockPost).toHaveBeenCalledTimes(2); // task 20 never attempted — no retry, immediate stop
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
    // task 10 in the test project, task 20 outside it
    mockGet.mockImplementation(async (endpoint: string) =>
      endpoint.startsWith("task/10")
        ? { task: { id: 10, project: { id: TEST_PROJECT } } }
        : { task: { id: 20, project: { id: 111 } } });
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    await expect(handleLogWorkday(day([entry(10, "09:00", "10:00"), entry(20, "10:00", "11:00")])))
      .rejects.toThrow(/log_workday refused.*task 20.*111.*572465/s);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("ON: all tasks inside MCP-Test → writes proceed", async () => {
    vi.stubEnv("PLANFIX_SAFE_MODE", "1");
    vi.stubEnv("PLANFIX_TEST_PROJECT_ID", String(TEST_PROJECT));
    mockGet.mockResolvedValue({ task: { id: 10, project: { id: TEST_PROJECT } } });
    mockPost.mockResolvedValue({ result: "success", keys: [1], commentId: 500 });
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    const result = await handleLogWorkday(day([entry(10, "09:00", "10:00")]));
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(result).toContain("✓ Workday");
  });

  it("ON without a test project id: fail-closed before any HTTP", async () => {
    vi.stubEnv("PLANFIX_SAFE_MODE", "1");
    vi.stubEnv("PLANFIX_TEST_PROJECT_ID", "");
    const { handleLogWorkday } = await import("../src/tools/timeentries.js");
    await expect(handleLogWorkday(day([entry(10, "09:00", "10:00")])))
      .rejects.toThrow(/PLANFIX_TEST_PROJECT_ID is unset or not a positive integer/);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });
});
