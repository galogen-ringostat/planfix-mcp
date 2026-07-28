import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/client.js", () => ({
  planfixPost: vi.fn(),
  planfixGet: vi.fn(),
}));

import { planfixPost, planfixGet } from "../src/client.js";

const mockPost = vi.mocked(planfixPost);
const mockGet = vi.mocked(planfixGet);

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllEnvs(); });

function comments(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    dateTime: { datetime: `2026-07-0${(i % 9) + 1} 10:00` },
    owner: { id: 403, name: "Galogen" },
    description: `comment ${i + 1}`,
  }));
}

describe("get_task_full", () => {
  it("fetches task and comments in parallel and renders both", async () => {
    mockGet.mockResolvedValue({ task: { id: 5, name: "Card", project: { id: 1, name: "P" } } });
    mockPost.mockResolvedValue({ comments: comments(2) });
    const { handleGetTaskFull } = await import("../src/tools/tasks.js");
    const result = await handleGetTaskFull({ taskId: 5 });

    expect(mockGet).toHaveBeenCalledWith("task/5", { fields: expect.stringContaining("name") });
    // default limit 30, over-fetched by one for exact has_more
    expect(mockPost).toHaveBeenCalledWith("task/5/comments/list", {
      offset: 0,
      pageSize: 31,
      fields: "id,dateTime,owner,description,files",
    });
    expect(result).toContain("#5");
    expect(result).toContain("Card");
    expect(result).toContain("comment 1");
    expect(result).toContain("Galogen");
    expect(result).toContain("2026-07-01 10:00");
    expect(result).toContain("has_more: false");
  });

  it("reports has_more with a get_comments hint when comments are truncated", async () => {
    mockGet.mockResolvedValue({ task: { id: 7, name: "Busy" } });
    mockPost.mockResolvedValue({ comments: comments(4) }); // limit 3 → 4 rows returned
    const { handleGetTaskFull } = await import("../src/tools/tasks.js");
    const result = await handleGetTaskFull({ taskId: 7, commentsLimit: 3 });

    expect(mockPost).toHaveBeenCalledWith("task/7/comments/list", expect.objectContaining({ pageSize: 4 }));
    expect(result).toContain("comment 3");
    expect(result).not.toContain("comment 4"); // the over-fetched row is never rendered
    expect(result).toContain("has_more: true");
    expect(result).toMatch(/get_comments.*taskId: 7.*offset: 3/s);
  });

  it("renders a task with zero comments", async () => {
    mockGet.mockResolvedValue({ task: { id: 8, name: "Quiet" } });
    mockPost.mockResolvedValue({ comments: [] });
    const { handleGetTaskFull } = await import("../src/tools/tasks.js");
    const result = await handleGetTaskFull({ taskId: 8 });
    expect(result).toContain("Quiet");
    expect(result).toContain("has_more: false");
  });

  it("is unaffected by safe mode ON (read-only)", async () => {
    vi.stubEnv("PLANFIX_SAFE_MODE", "1");
    vi.stubEnv("PLANFIX_TEST_PROJECT_ID", "572465");
    mockGet.mockResolvedValue({ task: { id: 5, name: "Card" } });
    mockPost.mockResolvedValue({ comments: comments(1) });
    const { handleGetTaskFull } = await import("../src/tools/tasks.js");
    const result = await handleGetTaskFull({ taskId: 5 });
    // identical call pattern to safe mode OFF: one GET (the task itself), one POST (comments list)
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith("task/5", { fields: expect.any(String) });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(result).toContain("Card");
  });
});

describe("search_tasks", () => {
  const tasks = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: 100 + i,
      name: `Task ${i + 1}`,
      status: { id: 1, name: "New" },
      assignees: { users: [{ id: 403, name: "Galogen" }] },
      project: { id: 572465, name: "MCP-Test" },
    }));

  it("maps nameContains to filter type 8 (equal)", async () => {
    mockPost.mockResolvedValue({ tasks: tasks(1) });
    const { handleSearchTasks } = await import("../src/tools/tasks.js");
    await handleSearchTasks({ nameContains: "report" });
    expect(mockPost).toHaveBeenCalledWith("task/list", expect.objectContaining({
      filters: [{ type: 8, operator: "equal", value: "report" }],
    }));
  });

  it("maps assigneeId to filter type 2 with user: prefix", async () => {
    mockPost.mockResolvedValue({ tasks: [] });
    const { handleSearchTasks } = await import("../src/tools/tasks.js");
    await handleSearchTasks({ assigneeId: 403 });
    expect(mockPost).toHaveBeenCalledWith("task/list", expect.objectContaining({
      filters: [{ type: 2, operator: "equal", value: "user:403" }],
    }));
  });

  it("maps statusId to filter type 10", async () => {
    mockPost.mockResolvedValue({ tasks: [] });
    const { handleSearchTasks } = await import("../src/tools/tasks.js");
    await handleSearchTasks({ statusId: 127 });
    expect(mockPost).toHaveBeenCalledWith("task/list", expect.objectContaining({
      filters: [{ type: 10, operator: "equal", value: 127 }],
    }));
  });

  it("maps projectId to filter type 5", async () => {
    mockPost.mockResolvedValue({ tasks: [] });
    const { handleSearchTasks } = await import("../src/tools/tasks.js");
    await handleSearchTasks({ projectId: 572465 });
    expect(mockPost).toHaveBeenCalledWith("task/list", expect.objectContaining({
      filters: [{ type: 5, operator: "equal", value: 572465 }],
    }));
  });

  it("maps updatedSince to filter type 79 (change OR comment date), operator gt, DD-MM-YYYY", async () => {
    // Type 79, not 38: the task-mirror sync must treat a new comment as task
    // activity; type 38 (latest change only) misses comment-only activity.
    mockPost.mockResolvedValue({ tasks: [] });
    const { handleSearchTasks } = await import("../src/tools/tasks.js");
    await handleSearchTasks({ updatedSince: "2026-07-01" });
    expect(mockPost).toHaveBeenCalledWith("task/list", expect.objectContaining({
      filters: [{ type: 79, operator: "gt", value: { dateType: "otherDate", dateValue: "01-07-2026" } }],
    }));
  });

  it("combines multiple filters (AND) and requests compact fields with pageSize+1", async () => {
    mockPost.mockResolvedValue({ tasks: tasks(2) });
    const { handleSearchTasks } = await import("../src/tools/tasks.js");
    await handleSearchTasks({ nameContains: "x", projectId: 9, pageSize: 20, offset: 40 });
    const body = mockPost.mock.calls[0][1] as Record<string, unknown>;
    expect(body.filters).toEqual([
      { type: 8, operator: "equal", value: "x" },
      { type: 5, operator: "equal", value: 9 },
    ]);
    expect(body.offset).toBe(40);
    expect(body.pageSize).toBe(21); // over-fetch by one for exact has_more
    expect(body.fields).toBe("id,name,status,assignees,project");
  });

  it("refuses an unfiltered call, pointing to get_tasks, without any HTTP call", async () => {
    const { handleSearchTasks } = await import("../src/tools/tasks.js");
    await expect(handleSearchTasks({})).rejects.toThrow(/at least one filter.*get_tasks/s);
    await expect(handleSearchTasks({ pageSize: 10, offset: 0 })).rejects.toThrow(/at least one filter/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("error and hint strings contain no Cyrillic (CLAUDE.md English-errors rule)", async () => {
    const { handleSearchTasks, handleGetTaskFull } = await import("../src/tools/tasks.js");

    // unfiltered refusal
    const err = await handleSearchTasks({}).then(
      () => { throw new Error("expected the unfiltered refusal"); },
      (e: Error) => e,
    );
    expect(err.message).not.toMatch(/[а-яА-ЯёЁ]/);

    // empty-result relax-the-filters hint
    mockPost.mockResolvedValueOnce({ tasks: [] });
    const empty = await handleSearchTasks({ nameContains: "zzz" });
    expect(empty).not.toMatch(/[а-яА-ЯёЁ]/);

    // truncated-page footer (has_more + next offset); data labels excluded by
    // rendering tasks with English-only field values
    mockPost.mockResolvedValueOnce({ tasks: [{ id: 1, name: "a" }, { id: 2, name: "b" }] });
    const page = await handleSearchTasks({ nameContains: "a", pageSize: 1 });
    const searchFooter = page.split("\n").at(-1)!;
    expect(searchFooter).toContain("has_more: true");
    expect(searchFooter).not.toMatch(/[а-яА-ЯёЁ]/);

    // get_task_full truncation footer
    mockGet.mockResolvedValue({ task: { id: 7, name: "t" } });
    mockPost.mockResolvedValueOnce({ comments: comments(2) });
    const full = await handleGetTaskFull({ taskId: 7, commentsLimit: 1 });
    const fullFooter = full.split("\n").at(-1)!;
    expect(fullFooter).toContain("has_more: true");
    expect(fullFooter).not.toMatch(/[а-яА-ЯёЁ]/);
  });

  it("renders compact rows and has_more with next offset when truncated", async () => {
    mockPost.mockResolvedValue({ tasks: tasks(3) }); // pageSize 2 → 3 rows returned
    const { handleSearchTasks } = await import("../src/tools/tasks.js");
    const result = await handleSearchTasks({ projectId: 572465, pageSize: 2 });
    expect(result).toContain("#100");
    expect(result).toContain("Task 2");
    expect(result).not.toContain("Task 3"); // the over-fetched row is never rendered
    expect(result).toContain("Galogen");
    expect(result).toContain("MCP-Test");
    expect(result).toContain("has_more: true");
    expect(result).toContain("offset: 2");
  });

  it("reports has_more: false on a final page and a hint on empty results", async () => {
    mockPost.mockResolvedValueOnce({ tasks: tasks(1) });
    const { handleSearchTasks } = await import("../src/tools/tasks.js");
    expect(await handleSearchTasks({ projectId: 1, pageSize: 5 })).toContain("has_more: false");
    mockPost.mockResolvedValueOnce({ tasks: [] });
    expect(await handleSearchTasks({ nameContains: "zzz" })).toContain("No tasks matched");
  });

  it("rejects a malformed updatedSince via Zod with an actionable message", async () => {
    const { searchTasksSchema } = await import("../src/tools/tasks.js");
    const parsed = searchTasksSchema.safeParse({ updatedSince: "01-07-2026" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toMatch(/YYYY-MM-DD/);
    }
  });

  it("is unaffected by safe mode ON (read-only)", async () => {
    vi.stubEnv("PLANFIX_SAFE_MODE", "1");
    vi.stubEnv("PLANFIX_TEST_PROJECT_ID", "572465");
    mockPost.mockResolvedValue({ tasks: tasks(1) });
    const { handleSearchTasks } = await import("../src/tools/tasks.js");
    const result = await handleSearchTasks({ nameContains: "report" });
    // identical call pattern to safe mode OFF: exactly one POST, no guard GET
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockGet).not.toHaveBeenCalled();
    expect(result).toContain("Task 1");
  });
});
