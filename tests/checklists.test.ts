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
const CYRILLIC_BAN_SCOPE = /[а-яА-ЯёЁ]/; // applied to errors/hints/footers, not data labels

const item = (id: number, isDone = false) => ({ id, name: `Step ${id}`, isDone });

function inTestProject(): void {
  mockGet.mockResolvedValue({ task: { id: 9, project: { id: TEST_PROJECT } } });
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("get_task_checklist", () => {
  it("posts to task/:id/checklist/list with fields and over-fetch, renders [x]/[ ] rows", async () => {
    mockPost.mockResolvedValue({ items: [item(1, true), item(2, false)] });
    const { handleGetTaskChecklist } = await import("../src/tools/checklists.js");
    const result = await handleGetTaskChecklist({ taskId: 123 });
    expect(mockPost).toHaveBeenCalledWith("task/123/checklist/list", {
      offset: 0,
      pageSize: 51, // default 50 + 1 over-fetch
      fields: "id,name,isDone,assignees",
    });
    expect(result).toContain("#1 | Step 1 | [x]");
    expect(result).toContain("#2 | Step 2 | [ ]");
    expect(result.split("\n").at(-1)).toBe("has_more: false");
  });

  it("paginates: truncated page has exact has_more naming the tool; over-fetched row unrendered", async () => {
    mockPost.mockResolvedValue({ items: [item(1), item(2), item(3)] });
    const { handleGetTaskChecklist } = await import("../src/tools/checklists.js");
    const result = await handleGetTaskChecklist({ taskId: 123, pageSize: 2 });
    expect(result).toContain("Step 2");
    expect(result).not.toContain("Step 3");
    const footer = result.split("\n").at(-1)!;
    expect(footer).toBe("has_more: true — next page: get_task_checklist with offset: 2.");
    expect(footer).not.toMatch(CYRILLIC_BAN_SCOPE);
  });

  it("final page with offset numbering reports has_more: false", async () => {
    mockPost.mockResolvedValue({ items: [item(9)] });
    const { handleGetTaskChecklist } = await import("../src/tools/checklists.js");
    const result = await handleGetTaskChecklist({ taskId: 123, pageSize: 2, offset: 4 });
    expect(result).toContain("5. #9");
    expect(result.split("\n").at(-1)).toBe("has_more: false");
  });

  it("empty checklist: English hint", async () => {
    mockPost.mockResolvedValue({ items: [] });
    const { handleGetTaskChecklist } = await import("../src/tools/checklists.js");
    const result = await handleGetTaskChecklist({ taskId: 42 });
    expect(result).toBe("Task 42 has no checklist items. has_more: false");
    expect(result).not.toMatch(CYRILLIC_BAN_SCOPE);
  });

  it("is unaffected by safe mode ON (read-only, no guard GET)", async () => {
    vi.stubEnv("PLANFIX_SAFE_MODE", "1");
    vi.stubEnv("PLANFIX_TEST_PROJECT_ID", String(TEST_PROJECT));
    mockPost.mockResolvedValue({ items: [item(1)] });
    const { handleGetTaskChecklist } = await import("../src/tools/checklists.js");
    await handleGetTaskChecklist({ taskId: 123 });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe("add_checklist_item", () => {
  it("posts name only by default and reports the new id", async () => {
    mockMutate.mockResolvedValue({ result: "success", id: 777 });
    const { handleAddChecklistItem } = await import("../src/tools/checklists.js");
    const result = await handleAddChecklistItem({ taskId: 9, name: "Review the draft" });
    expect(mockMutate).toHaveBeenCalledWith("task/9/checklist", { name: "Review the draft" });
    expect(result).toContain("✓ Checklist item created: id 777 on task 9.");
    expect(result).not.toMatch(CYRILLIC_BAN_SCOPE);
  });

  it("passes isDone and prefixed assignee when provided", async () => {
    mockMutate.mockResolvedValue({ result: "success", id: 778 });
    const { handleAddChecklistItem } = await import("../src/tools/checklists.js");
    await handleAddChecklistItem({ taskId: 9, name: "x", isDone: true, assigneeId: 403 });
    expect(mockMutate).toHaveBeenCalledWith("task/9/checklist", {
      name: "x",
      isDone: true,
      assignees: { users: [{ id: "user:403" }] },
    });
  });

  it("falls back to raw JSON on an unexpected response shape (no id)", async () => {
    mockMutate.mockResolvedValue({ result: "success" });
    const { handleAddChecklistItem } = await import("../src/tools/checklists.js");
    const result = await handleAddChecklistItem({ taskId: 9, name: "x" });
    expect(result).toContain("unexpected shape");
    expect(result).not.toContain("✓");
  });

  it("safe mode ON: allowed inside MCP-Test (guard GET precedes POST), refused outside", async () => {
    vi.stubEnv("PLANFIX_SAFE_MODE", "1");
    vi.stubEnv("PLANFIX_TEST_PROJECT_ID", String(TEST_PROJECT));
    inTestProject();
    mockMutate.mockResolvedValue({ result: "success", id: 1 });
    const { handleAddChecklistItem } = await import("../src/tools/checklists.js");
    await handleAddChecklistItem({ taskId: 9, name: "x" });
    expect(mockGet.mock.invocationCallOrder[0]).toBeLessThan(mockMutate.mock.invocationCallOrder[0]);

    vi.clearAllMocks();
    mockGet.mockResolvedValue({ task: { id: 9, project: { id: 111 } } });
    await expect(handleAddChecklistItem({ taskId: 9, name: "x" }))
      .rejects.toThrow(/add_checklist_item refused.*task 9.*111.*572465/s);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("fail-closed before any HTTP", async () => {
    vi.stubEnv("PLANFIX_SAFE_MODE", "1");
    vi.stubEnv("PLANFIX_TEST_PROJECT_ID", "");
    const { handleAddChecklistItem } = await import("../src/tools/checklists.js");
    await expect(handleAddChecklistItem({ taskId: 9, name: "x" }))
      .rejects.toThrow(/PLANFIX_TEST_PROJECT_ID is unset or not a positive integer/);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockMutate).not.toHaveBeenCalled();
  });
});

describe("update_checklist_item_name", () => {
  it("posts {name} to task/:id/checklist/:itemId and echoes the new name", async () => {
    mockMutate.mockResolvedValue({ result: "success" });
    const { handleUpdateChecklistItemName } = await import("../src/tools/checklists.js");
    const result = await handleUpdateChecklistItemName({ taskId: 9, itemId: 456, name: "[cancelled] Review the draft" });
    expect(mockMutate).toHaveBeenCalledWith("task/9/checklist/456", { name: "[cancelled] Review the draft" });
    expect(result).toContain("✓ Checklist item 456 on task 9 renamed to: [cancelled] Review the draft");
    expect(result).not.toMatch(CYRILLIC_BAN_SCOPE);
  });

  it("rejects an empty name via Zod", async () => {
    const { updateChecklistItemNameSchema } = await import("../src/tools/checklists.js");
    expect(updateChecklistItemNameSchema.safeParse({ taskId: 9, itemId: 456, name: "" }).success).toBe(false);
    expect(updateChecklistItemNameSchema.safeParse({ taskId: 9, itemId: 456 }).success).toBe(false);
  });

  it("surfaces per-field failures instead of claiming success", async () => {
    mockMutate.mockResolvedValue({ result: "success", failures: [{ field: "name", error: "too long" }] });
    const { handleUpdateChecklistItemName } = await import("../src/tools/checklists.js");
    const result = await handleUpdateChecklistItemName({ taskId: 9, itemId: 456, name: "x" });
    expect(result).toContain("reported failures");
    expect(result).toContain("too long");
    expect(result).not.toContain("✓");
  });

  it("safe mode ON: wrong-project refusal before the POST; fail-closed before any HTTP", async () => {
    vi.stubEnv("PLANFIX_SAFE_MODE", "1");
    vi.stubEnv("PLANFIX_TEST_PROJECT_ID", String(TEST_PROJECT));
    mockGet.mockResolvedValue({ task: { id: 9, project: { id: 111 } } });
    const { handleUpdateChecklistItemName } = await import("../src/tools/checklists.js");
    await expect(handleUpdateChecklistItemName({ taskId: 9, itemId: 456, name: "x" }))
      .rejects.toThrow(/update_checklist_item_name refused.*task 9.*111.*572465/s);
    expect(mockMutate).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.stubEnv("PLANFIX_TEST_PROJECT_ID", "");
    await expect(handleUpdateChecklistItemName({ taskId: 9, itemId: 456, name: "x" }))
      .rejects.toThrow(/PLANFIX_TEST_PROJECT_ID is unset/);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockMutate).not.toHaveBeenCalled();
  });
});

describe("set_checklist_item_done", () => {
  it("checks an item: posts {isDone: true} to task/:id/checklist/:itemId", async () => {
    mockMutate.mockResolvedValue({ result: "success" });
    const { handleSetChecklistItemDone } = await import("../src/tools/checklists.js");
    const result = await handleSetChecklistItemDone({ taskId: 9, itemId: 456, isDone: true });
    expect(mockMutate).toHaveBeenCalledWith("task/9/checklist/456", { isDone: true });
    expect(result).toContain("✓ Checklist item 456 on task 9 marked checked [x].");
  });

  it("un-checks an item with explicit isDone: false", async () => {
    mockMutate.mockResolvedValue({ result: "success" });
    const { handleSetChecklistItemDone } = await import("../src/tools/checklists.js");
    const result = await handleSetChecklistItemDone({ taskId: 9, itemId: 456, isDone: false });
    expect(mockMutate).toHaveBeenCalledWith("task/9/checklist/456", { isDone: false });
    expect(result).toContain("marked unchecked [ ]");
    expect(result).not.toMatch(CYRILLIC_BAN_SCOPE);
  });

  it("isDone is required — Zod rejects its omission", async () => {
    const { setChecklistItemDoneSchema } = await import("../src/tools/checklists.js");
    const parsed = setChecklistItemDoneSchema.safeParse({ taskId: 9, itemId: 456 });
    expect(parsed.success).toBe(false);
  });

  it("surfaces per-field failures from a nominally successful update", async () => {
    mockMutate.mockResolvedValue({ result: "success", failures: [{ field: "isDone", error: "some reason" }] });
    const { handleSetChecklistItemDone } = await import("../src/tools/checklists.js");
    const result = await handleSetChecklistItemDone({ taskId: 9, itemId: 456, isDone: true });
    expect(result).toContain("reported failures");
    expect(result).toContain("some reason");
    expect(result).not.toContain("✓");
  });

  it("safe mode ON: refused for a task outside MCP-Test; fail-closed without a project id", async () => {
    vi.stubEnv("PLANFIX_SAFE_MODE", "1");
    vi.stubEnv("PLANFIX_TEST_PROJECT_ID", String(TEST_PROJECT));
    mockGet.mockResolvedValue({ task: { id: 9, project: { id: 111 } } });
    const { handleSetChecklistItemDone } = await import("../src/tools/checklists.js");
    await expect(handleSetChecklistItemDone({ taskId: 9, itemId: 456, isDone: true }))
      .rejects.toThrow(/set_checklist_item_done refused.*task 9/s);
    expect(mockMutate).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.stubEnv("PLANFIX_TEST_PROJECT_ID", "");
    await expect(handleSetChecklistItemDone({ taskId: 9, itemId: 456, isDone: true }))
      .rejects.toThrow(/PLANFIX_TEST_PROJECT_ID is unset/);
    expect(mockGet).not.toHaveBeenCalled();
  });
});
