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

const VALID_ENTRY = {
  taskId: 9,
  date: "2026-07-24",
  timeFrom: "10:00",
  timeTo: "10:30",
  type: "Task" as const,
  comment: "probe",
  userId: 403,
};

const EXPECTED_BODY = {
  dataTag: { id: 59 },
  items: [{
    customFieldData: [
      { field: { id: 173 }, value: [{ id: "user:403" }] },
      { field: { id: 175 }, value: { date: "24-07-2026" } },
      { field: { id: 185 }, value: { from: { time: "10:00" }, to: { time: "10:30" } } },
      { field: { id: 191 }, value: "Task" },
      { field: { id: 181 }, value: "probe" },
    ],
  }],
};

function entry(key: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    commentId: 500,
    customFieldData: [
      { field: { id: 175 }, value: { date: "24-07-2026" }, stringValue: "24-07-2026" },
      { field: { id: 185 }, value: { from: { time: "10:00" }, to: { time: "11:30" }, durationSec: 5400 }, stringValue: "10:00 - 11:30" },
      { field: { id: 173 }, value: [{ id: "user:403" }], stringValue: "Galogen" },
      { field: { id: 191 }, value: "Task", stringValue: "Task" },
      { field: { id: 181 }, value: "did things", stringValue: "did things" },
    ],
    ...over,
  };
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("add_time_entry", () => {
  it("posts the spike-verified body to task/:id/datatags/ and returns key + commentId", async () => {
    mockMutate.mockResolvedValue({ result: "success", keys: [127822], commentId: 47856597 });
    const { handleAddTimeEntry } = await import("../src/tools/timeentries.js");
    const result = await handleAddTimeEntry(VALID_ENTRY);
    expect(mockMutate).toHaveBeenCalledWith("task/9/datatags/", EXPECTED_BODY);
    expect(result).toContain("key 127822");
    expect(result).toContain("commentId 47856597");
    expect(result).toContain("commentId: 47856597"); // chaining hint
    expect(result).not.toMatch(/[а-яА-ЯёЁ]/);
  });

  it("with commentId posts to task/:id/datatags/:commentId (append to logging-period comment)", async () => {
    // Real append-endpoint response has NO commentId field (verified live,
    // entry 127824): { result, keys } only. The ack echoes the input commentId.
    mockMutate.mockResolvedValue({ result: "success", keys: [127900] });
    const { handleAddTimeEntry } = await import("../src/tools/timeentries.js");
    const result = await handleAddTimeEntry({ ...VALID_ENTRY, commentId: 555 });
    expect(mockMutate).toHaveBeenCalledWith("task/9/datatags/555", EXPECTED_BODY);
    expect(result).toContain("✓ Time entry created");
    expect(result).toContain("key 127900");
    expect(result).toContain("commentId 555");
    expect(result).toContain("commentId: 555"); // chaining hint still correct
  });

  it("append path with no keys in the response still falls back to raw JSON", async () => {
    mockMutate.mockResolvedValue({ result: "success" });
    const { handleAddTimeEntry } = await import("../src/tools/timeentries.js");
    const result = await handleAddTimeEntry({ ...VALID_ENTRY, commentId: 555 });
    expect(result).toContain("unexpected shape");
    expect(result).not.toContain("✓");
  });

  it("falls back to raw JSON on an unexpected response shape, in English", async () => {
    mockMutate.mockResolvedValue({ result: "success" }); // no keys/commentId
    const { handleAddTimeEntry } = await import("../src/tools/timeentries.js");
    const result = await handleAddTimeEntry(VALID_ENTRY);
    expect(result).toContain("unexpected shape");
    expect(result).not.toMatch(/[а-яА-ЯёЁ]/);
  });

  it("rejects malformed date and times via Zod with English messages", async () => {
    const { addTimeEntrySchema } = await import("../src/tools/timeentries.js");
    const badDate = addTimeEntrySchema.safeParse({ ...VALID_ENTRY, date: "24-07-2026" });
    expect(badDate.success).toBe(false);
    if (!badDate.success) expect(badDate.error.issues[0].message).toMatch(/YYYY-MM-DD/);

    const badFrom = addTimeEntrySchema.safeParse({ ...VALID_ENTRY, timeFrom: "9:30" });
    expect(badFrom.success).toBe(false);
    if (!badFrom.success) expect(badFrom.error.issues[0].message).toMatch(/HH:MM/);

    const badTo = addTimeEntrySchema.safeParse({ ...VALID_ENTRY, timeTo: "24:00" });
    expect(badTo.success).toBe(false);

    const badType = addTimeEntrySchema.safeParse({ ...VALID_ENTRY, type: "Coding" });
    expect(badType.success).toBe(false);

    for (const r of [badDate, badFrom, badTo]) {
      if (!r.success) expect(r.error.issues[0].message).not.toMatch(/[а-яА-ЯёЁ]/);
    }
  });

  it("safe mode ON: allowed when the task is in the test project (guard GET precedes POST)", async () => {
    vi.stubEnv("PLANFIX_SAFE_MODE", "1");
    vi.stubEnv("PLANFIX_TEST_PROJECT_ID", String(TEST_PROJECT));
    mockGet.mockResolvedValue({ task: { id: 9, project: { id: TEST_PROJECT } } });
    mockMutate.mockResolvedValue({ result: "success", keys: [1], commentId: 2 });
    const { handleAddTimeEntry } = await import("../src/tools/timeentries.js");
    await handleAddTimeEntry(VALID_ENTRY);
    expect(mockGet).toHaveBeenCalledWith("task/9", { fields: "id,project" });
    expect(mockMutate).toHaveBeenCalledWith("task/9/datatags/", EXPECTED_BODY);
    expect(mockGet.mock.invocationCallOrder[0]).toBeLessThan(mockMutate.mock.invocationCallOrder[0]);
  });

  it("safe mode ON: refused for a task outside the test project; no mutating POST", async () => {
    vi.stubEnv("PLANFIX_SAFE_MODE", "1");
    vi.stubEnv("PLANFIX_TEST_PROJECT_ID", String(TEST_PROJECT));
    mockGet.mockResolvedValue({ task: { id: 9, project: { id: 111 } } });
    const { handleAddTimeEntry } = await import("../src/tools/timeentries.js");
    await expect(handleAddTimeEntry(VALID_ENTRY)).rejects.toThrow(/add_time_entry refused.*task 9.*111.*572465/s);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("safe mode ON without a test project id: fail-closed before any HTTP", async () => {
    vi.stubEnv("PLANFIX_SAFE_MODE", "1");
    vi.stubEnv("PLANFIX_TEST_PROJECT_ID", "");
    const { handleAddTimeEntry } = await import("../src/tools/timeentries.js");
    await expect(handleAddTimeEntry(VALID_ENTRY)).rejects.toThrow(/PLANFIX_TEST_PROJECT_ID is unset or not a positive integer/);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe("get_task_time_entries", () => {
  it("posts to datatag/59/entry/list with taskId, numeric field ids, pageSize+1", async () => {
    mockPost.mockResolvedValue({ dataTagEntries: [entry(1)] });
    const { handleGetTaskTimeEntries } = await import("../src/tools/timeentries.js");
    const result = await handleGetTaskTimeEntries({ taskId: 42 });
    expect(mockPost).toHaveBeenCalledWith("datatag/59/entry/list", {
      offset: 0,
      pageSize: 31, // default 30 + 1 over-fetch
      fields: "key,task,commentId,173,175,185,191,181",
      taskId: 42,
    });
    expect(result).toContain("#1");
    expect(result).toContain("24-07-2026");
    expect(result).toContain("10:00 - 11:30 (1h 30m)");
    expect(result).toContain("Galogen");
    expect(result).toContain("did things");
    expect(result).toContain("commentId: 500");
    expect(result).toContain("has_more: false");
  });

  it("reports has_more with next offset when truncated; footer has no Cyrillic", async () => {
    mockPost.mockResolvedValue({ dataTagEntries: [entry(1), entry(2), entry(3)] });
    const { handleGetTaskTimeEntries } = await import("../src/tools/timeentries.js");
    const result = await handleGetTaskTimeEntries({ taskId: 42, pageSize: 2 });
    expect(result).toContain("#2");
    expect(result).not.toContain("#3"); // over-fetched row never rendered
    const footer = result.split("\n").at(-1)!;
    expect(footer).toContain("has_more: true");
    expect(footer).toContain("offset: 2");
    expect(footer).not.toMatch(/[а-яА-ЯёЁ]/);
  });

  it("renders an English empty-result line", async () => {
    mockPost.mockResolvedValue({ dataTagEntries: [] });
    const { handleGetTaskTimeEntries } = await import("../src/tools/timeentries.js");
    const result = await handleGetTaskTimeEntries({ taskId: 42 });
    expect(result).toContain("No time entries found");
    expect(result).not.toMatch(/[а-яА-ЯёЁ]/);
  });

  it("is unaffected by safe mode ON (read-only, no guard GET)", async () => {
    vi.stubEnv("PLANFIX_SAFE_MODE", "1");
    vi.stubEnv("PLANFIX_TEST_PROJECT_ID", String(TEST_PROJECT));
    mockPost.mockResolvedValue({ dataTagEntries: [entry(1)] });
    const { handleGetTaskTimeEntries } = await import("../src/tools/timeentries.js");
    const result = await handleGetTaskTimeEntries({ taskId: 42 });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockGet).not.toHaveBeenCalled();
    expect(result).toContain("#1");
  });
});
