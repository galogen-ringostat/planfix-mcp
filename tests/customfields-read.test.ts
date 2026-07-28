// ROADMAP P9 Part A: custom-field read/filter support on tasks.
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

// Shapes as returned live by GET task/412626?fields=id,name,22571,… (2026-07-26).
const CFD = [
  { field: { id: 22571, name: "[RevOps] Sprint", type: 8, enumValues: [{ id: 1, value: "Sprint 4 - 2026" }] }, value: "Sprint 4 - 2026", stringValue: "Sprint 4 - 2026" },
  { field: { id: 22453, name: "Estimation RevOps", type: 23 }, value: 1800, stringValue: "30 ч" },
  { field: { id: 22451, name: "Time spent RevOps", type: 23 }, value: 4570, stringValue: "76 ч 10 мин" },
];

describe("customFieldData rendering", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("formatTask renders name: stringValue segments, no metadata", async () => {
    const { formatTask } = await import("../src/format.js");
    const row = formatTask({ id: 412626, name: "T", customFieldData: CFD });
    expect(row).toContain("[RevOps] Sprint: Sprint 4 - 2026");
    expect(row).toContain("Estimation RevOps: 30 ч");
    expect(row).toContain("Time spent RevOps: 76 ч 10 мин");
    expect(row).not.toContain("enumValues");
    expect(row).not.toContain("1800"); // stringValue wins over raw value
  });

  it("falls back to a scalar raw value when stringValue is absent, skips non-scalar values", async () => {
    const { formatTask } = await import("../src/format.js");
    const row = formatTask({ id: 1, name: "T", customFieldData: [
      { field: { id: 1, name: "Num" }, value: 42 },
      { field: { id: 2, name: "People" }, value: [{ id: "user:1" }] }, // non-scalar, no stringValue → skipped
      { field: { id: 3 }, value: "orphan" },                            // no field name → skipped
    ] });
    expect(row).toContain("Num: 42");
    expect(row).not.toContain("People");
    expect(row).not.toContain("orphan");
  });

  it("get_task passes numeric ids through fields and renders the values", async () => {
    mockGet.mockResolvedValue({ task: { id: 412626, name: "T", customFieldData: CFD } });
    const { handleGetTask } = await import("../src/tools/tasks.js");
    const out = await handleGetTask({ taskId: 412626, fields: "id,name,22571,22453,22451" });
    expect(mockGet).toHaveBeenCalledWith("task/412626", { fields: "id,name,22571,22453,22451" });
    expect(out).toContain("Estimation RevOps: 30 ч");
  });

  it("search_tasks result rows render customFieldData", async () => {
    mockPost.mockResolvedValue({ tasks: [{ id: 1, name: "T", customFieldData: CFD }] });
    const { handleSearchTasks } = await import("../src/tools/tasks.js");
    const out = await handleSearchTasks({ customField: { fieldId: 22571, value: "Sprint 4 - 2026" } });
    expect(out).toContain("[RevOps] Sprint: Sprint 4 - 2026");
  });

  it("CONCISE task rows stay identifier-grade (no custom field segments)", async () => {
    mockGet.mockResolvedValue({ task: { id: 1, name: "T", status: { id: 1 }, customFieldData: CFD } });
    const { handleGetTask } = await import("../src/tools/tasks.js");
    const out = await handleGetTask({ taskId: 1, response_format: "CONCISE" });
    expect(out).not.toContain("Sprint");
  });
});

describe("custom-field filtering", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("get_tasks no longer strips the `field` key from ad-hoc filters (P9 bug fix)", async () => {
    mockPost.mockResolvedValue({ tasks: [] });
    const { getTasksSchema, handleGetTasks } = await import("../src/tools/tasks.js");
    const raw = { filters: [{ type: 106, operator: "equal", value: "Sprint 4 - 2026", field: 22571 }] };
    const parsed = getTasksSchema.parse(raw); // Zod must PRESERVE field
    expect(parsed.filters?.[0]).toMatchObject({ field: 22571 });
    await handleGetTasks(parsed);
    expect(mockPost).toHaveBeenCalledWith("task/list", expect.objectContaining({
      filters: [{ type: 106, operator: "equal", value: "Sprint 4 - 2026", field: 22571 }],
    }));
  });

  it("search_tasks customField maps to a type-106 filter with the field key", async () => {
    mockPost.mockResolvedValue({ tasks: [] });
    const { handleSearchTasks } = await import("../src/tools/tasks.js");
    await handleSearchTasks({ customField: { fieldId: 22571, value: "Sprint 10 - 2026" } });
    expect(mockPost).toHaveBeenCalledWith("task/list", expect.objectContaining({
      filters: [{ type: 106, operator: "equal", value: "Sprint 10 - 2026", field: 22571 }],
    }));
  });

  it("search_tasks fetches the filtered field plus customFieldIds (deduplicated) for rendering", async () => {
    mockPost.mockResolvedValue({ tasks: [] });
    const { handleSearchTasks } = await import("../src/tools/tasks.js");
    await handleSearchTasks({
      customField: { fieldId: 22571, value: "Sprint 10 - 2026" },
      customFieldIds: [22453, 22451, 22571],
    });
    const body = mockPost.mock.calls[0][1] as { fields: string };
    const ids = body.fields.split(",");
    expect(ids).toContain("22571");
    expect(ids).toContain("22453");
    expect(ids).toContain("22451");
    expect(ids.filter((x) => x === "22571")).toHaveLength(1);
  });

  it("customFieldIds alone is display-only — not a filter, so filterless calls still refuse", async () => {
    const { handleSearchTasks } = await import("../src/tools/tasks.js");
    const err = await handleSearchTasks({ customFieldIds: [22453] }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("customField");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("schema rejects a customField without value or with an empty label", async () => {
    const { searchTasksSchema } = await import("../src/tools/tasks.js");
    expect(searchTasksSchema.safeParse({ customField: { fieldId: 22571 } }).success).toBe(false);
    expect(searchTasksSchema.safeParse({ customField: { fieldId: 22571, value: "" } }).success).toBe(false);
    expect(searchTasksSchema.safeParse({ customField: { fieldId: 22571, value: "x" } }).success).toBe(true);
  });

  it("get_task_full forwards a custom fields list to the task fetch", async () => {
    mockGet.mockResolvedValue({ task: { id: 5, name: "T", customFieldData: CFD } });
    mockPost.mockResolvedValue({ comments: [] });
    const { handleGetTaskFull } = await import("../src/tools/tasks.js");
    const out = await handleGetTaskFull({ taskId: 5, fields: "id,name,22453" });
    expect(mockGet).toHaveBeenCalledWith("task/5", { fields: "id,name,22453" });
    expect(out).toContain("Estimation RevOps: 30 ч");
  });
});
