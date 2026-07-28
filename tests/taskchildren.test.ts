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

const CYRILLIC = /[а-яА-ЯёЁ]/;

const child = (id: number) => ({
  id,
  name: `Sub ${id}`,
  status: { id: 1, name: "New" },
  assignees: { users: [{ id: 403, name: "Galogen" }] },
  project: { id: 9, name: "Proj" },
});

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("get_task_children", () => {
  it("queries task/list with the direct-parent filter (type 73) and compact fields", async () => {
    mockPost.mockResolvedValue({ tasks: [child(1), child(2)] });
    const { handleGetTaskChildren } = await import("../src/tools/tasks.js");
    const result = await handleGetTaskChildren({ taskId: 123 });
    expect(mockPost).toHaveBeenCalledWith("task/list", {
      offset: 0,
      pageSize: 51, // default 50 + 1 over-fetch
      fields: "id,name,status,assignees,project",
      filters: [{ type: 73, operator: "equal", value: 123 }],
    });
    expect(result).toContain("#1");
    expect(result).toContain("Sub 2");
    expect(result).toContain("Galogen");
    expect(result).toContain("Proj");
    expect(result.split("\n").at(-1)).toBe("has_more: false");
  });

  it("paginates with exact has_more naming get_task_children, over-fetched row unrendered", async () => {
    mockPost.mockResolvedValue({ tasks: [child(1), child(2), child(3)] });
    const { handleGetTaskChildren } = await import("../src/tools/tasks.js");
    const result = await handleGetTaskChildren({ taskId: 123, pageSize: 2 });
    expect(mockPost).toHaveBeenCalledWith("task/list", expect.objectContaining({ pageSize: 3 }));
    expect(result).toContain("Sub 2");
    expect(result).not.toContain("Sub 3");
    const footer = result.split("\n").at(-1)!;
    expect(footer).toBe("has_more: true — next page: get_task_children with the same filters and offset: 2.");
    expect(footer).not.toMatch(CYRILLIC);
  });

  it("final page reports has_more: false with offset-based numbering", async () => {
    mockPost.mockResolvedValue({ tasks: [child(9)] });
    const { handleGetTaskChildren } = await import("../src/tools/tasks.js");
    const result = await handleGetTaskChildren({ taskId: 123, pageSize: 2, offset: 4 });
    expect(result).toContain("5. #9");
    expect(result.split("\n").at(-1)).toBe("has_more: false");
  });

  it("CONCISE requests id,name,status and renders identifier-grade rows", async () => {
    mockPost.mockResolvedValue({ tasks: [child(1)] });
    const { handleGetTaskChildren } = await import("../src/tools/tasks.js");
    const result = await handleGetTaskChildren({ taskId: 123, response_format: "CONCISE" });
    expect(mockPost).toHaveBeenCalledWith("task/list", expect.objectContaining({ fields: "id,name,status" }));
    expect(result).toContain("#1");
    expect(result).toContain("New");
    expect(result).not.toContain("Galogen");
    expect(result).not.toContain("Proj");
  });

  it("DETAILED is the default and keeps assignees/project", async () => {
    mockPost.mockResolvedValue({ tasks: [child(1)] });
    const { handleGetTaskChildren } = await import("../src/tools/tasks.js");
    const result = await handleGetTaskChildren({ taskId: 123, response_format: "DETAILED" });
    expect(mockPost).toHaveBeenCalledWith("task/list", expect.objectContaining({ fields: expect.stringContaining("assignees") }));
    expect(result).toContain("Galogen");
  });

  it("empty result: English no-subtasks hint", async () => {
    mockPost.mockResolvedValue({ tasks: [] });
    const { handleGetTaskChildren } = await import("../src/tools/tasks.js");
    const result = await handleGetTaskChildren({ taskId: 42 });
    expect(result).toBe("Task 42 has no subtasks. has_more: false");
    expect(result).not.toMatch(CYRILLIC);
  });

  it("is unaffected by safe mode ON (read-only, no guard GET)", async () => {
    vi.stubEnv("PLANFIX_SAFE_MODE", "1");
    vi.stubEnv("PLANFIX_TEST_PROJECT_ID", "572465");
    mockPost.mockResolvedValue({ tasks: [child(1)] });
    const { handleGetTaskChildren } = await import("../src/tools/tasks.js");
    const result = await handleGetTaskChildren({ taskId: 123 });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockGet).not.toHaveBeenCalled();
    expect(result).toContain("#1");
  });
});
