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
const OTHER_PROJECT = 111;

function mockTaskInProject(projectId: number | undefined): void {
  mockGet.mockResolvedValue({
    task: { id: 10, ...(projectId !== undefined ? { project: { id: projectId } } : {}) },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function enableSafeMode(testProjectId?: string): void {
  vi.stubEnv("PLANFIX_SAFE_MODE", "1");
  if (testProjectId !== undefined) {
    vi.stubEnv("PLANFIX_TEST_PROJECT_ID", testProjectId);
  } else {
    vi.stubEnv("PLANFIX_TEST_PROJECT_ID", "");
  }
}

describe("safe mode OFF — behavior unchanged", () => {
  // Explicit stub keeps these tests hermetic even if the host env sets the variable.
  beforeEach(() => { vi.stubEnv("PLANFIX_SAFE_MODE", ""); });

  it("is off when PLANFIX_SAFE_MODE is unset or explicitly falsy", async () => {
    const { isSafeModeOn } = await import("../src/safemode.js");
    for (const v of ["", "0", "false", "off", "no", "FALSE", " 0 "]) {
      vi.stubEnv("PLANFIX_SAFE_MODE", v);
      expect(isSafeModeOn(), `PLANFIX_SAFE_MODE=${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("create_task posts without any project restriction", async () => {
    mockMutate.mockResolvedValue({ result: "success", id: 10 });
    const { handleCreateTask } = await import("../src/tools/tasks.js");
    await handleCreateTask({ name: "Prod task", projectId: OTHER_PROJECT });
    expect(mockMutate).toHaveBeenCalledWith("task/", { name: "Prod task", project: { id: OTHER_PROJECT } });
  });

  it("update_task posts directly — no extra GET is issued", async () => {
    mockMutate.mockResolvedValue({});
    const { handleUpdateTask } = await import("../src/tools/tasks.js");
    await handleUpdateTask({ taskId: 10, name: "Updated" });
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockMutate).toHaveBeenCalledWith("task/10", { name: "Updated" });
  });

  it("add_comment posts directly — no extra GET is issued", async () => {
    mockMutate.mockResolvedValue({ result: "success", id: 99 });
    const { handleAddComment } = await import("../src/tools/comments.js");
    await handleAddComment({ taskId: 10, body: "Hello" });
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockMutate).toHaveBeenCalledWith("task/10/comments/", { description: "Hello" });
  });

  it("create_contact / update_contact / upload_file_from_url work unchanged", async () => {
    mockMutate.mockResolvedValue({ result: "success", id: 1 });
    const { handleCreateContact, handleUpdateContact } = await import("../src/tools/contacts.js");
    const { handleUploadFileFromUrl } = await import("../src/tools/files.js");
    await handleCreateContact({ name: "Acme" });
    await handleUpdateContact({ contactId: 5, name: "Renamed" });
    await handleUploadFileFromUrl({ url: "https://x/y.pdf" });
    expect(mockMutate).toHaveBeenNthCalledWith(1, "contact/", { name: "Acme" });
    expect(mockMutate).toHaveBeenNthCalledWith(2, "contact/5", { name: "Renamed" });
    expect(mockMutate).toHaveBeenNthCalledWith(3, "file/from-url/", { url: "https://x/y.pdf" });
  });
});

describe("safe mode ON — allowed paths", () => {
  beforeEach(() => enableSafeMode(String(TEST_PROJECT)));

  it("create_task targeting the test project is allowed", async () => {
    mockMutate.mockResolvedValue({ result: "success", id: 10 });
    const { handleCreateTask } = await import("../src/tools/tasks.js");
    await handleCreateTask({ name: "[MCP-TEST] task", projectId: TEST_PROJECT });
    expect(mockMutate).toHaveBeenCalledWith("task/", {
      name: "[MCP-TEST] task",
      project: { id: TEST_PROJECT },
    });
  });

  it("update_task resolves the task first and proceeds when it is in the test project", async () => {
    mockTaskInProject(TEST_PROJECT);
    mockMutate.mockResolvedValue({});
    const { handleUpdateTask } = await import("../src/tools/tasks.js");
    await handleUpdateTask({ taskId: 10, name: "Updated" });
    expect(mockGet).toHaveBeenCalledWith("task/10", { fields: "id,project" });
    expect(mockMutate).toHaveBeenCalledWith("task/10", { name: "Updated" });
    expect(mockGet.mock.invocationCallOrder[0]).toBeLessThan(mockMutate.mock.invocationCallOrder[0]);
  });

  it("add_comment resolves the task first and proceeds when it is in the test project", async () => {
    mockTaskInProject(TEST_PROJECT);
    mockMutate.mockResolvedValue({ result: "success", id: 99 });
    const { handleAddComment } = await import("../src/tools/comments.js");
    await handleAddComment({ taskId: 10, body: "Hi" });
    expect(mockGet).toHaveBeenCalledWith("task/10", { fields: "id,project" });
    expect(mockMutate).toHaveBeenCalledWith("task/10/comments/", { description: "Hi" });
  });
});

describe("safe mode ON — refused paths", () => {
  beforeEach(() => enableSafeMode(String(TEST_PROJECT)));

  it("create_task targeting another project is refused; no HTTP call", async () => {
    const { handleCreateTask } = await import("../src/tools/tasks.js");
    await expect(handleCreateTask({ name: "x", projectId: OTHER_PROJECT }))
      .rejects.toThrow(/create_task refused.*111.*572465/s);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("create_task with no projectId is refused; no HTTP call", async () => {
    const { handleCreateTask } = await import("../src/tools/tasks.js");
    await expect(handleCreateTask({ name: "x" })).rejects.toThrow(/create_task refused/);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("update_task on a task outside the test project is refused; no mutating POST", async () => {
    mockTaskInProject(OTHER_PROJECT);
    const { handleUpdateTask } = await import("../src/tools/tasks.js");
    await expect(handleUpdateTask({ taskId: 10, name: "x" }))
      .rejects.toThrow(/update_task refused.*task 10.*project 111.*572465/s);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("update_task on a task with no project is refused (fail closed)", async () => {
    mockTaskInProject(undefined);
    const { handleUpdateTask } = await import("../src/tools/tasks.js");
    await expect(handleUpdateTask({ taskId: 10, name: "x" })).rejects.toThrow(/no readable project/);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("add_comment on a task outside the test project is refused; no mutating POST", async () => {
    mockTaskInProject(OTHER_PROJECT);
    const { handleAddComment } = await import("../src/tools/comments.js");
    await expect(handleAddComment({ taskId: 10, body: "x" }))
      .rejects.toThrow(/add_comment refused.*task 10/s);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("create_contact is refused entirely; no HTTP call", async () => {
    const { handleCreateContact } = await import("../src/tools/contacts.js");
    await expect(handleCreateContact({ name: "Acme" }))
      .rejects.toThrow(/create_contact.*refused.*no project scoping/s);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("update_contact is refused entirely; no HTTP call", async () => {
    const { handleUpdateContact } = await import("../src/tools/contacts.js");
    await expect(handleUpdateContact({ contactId: 5, name: "x" }))
      .rejects.toThrow(/update_contact on contact 5 refused/);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("upload_file_from_url is refused entirely; no HTTP call", async () => {
    const { handleUploadFileFromUrl } = await import("../src/tools/files.js");
    await expect(handleUploadFileFromUrl({ url: "https://x/y.pdf" }))
      .rejects.toThrow(/upload_file_from_url.*refused.*no task\/project target/s);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("read-only tools are unaffected", async () => {
    mockGet.mockResolvedValue({ task: { id: 5, name: "T" } });
    mockPost.mockResolvedValue({ tasks: [] });
    const { handleGetTask, handleGetTasks } = await import("../src/tools/tasks.js");
    await handleGetTask({ taskId: 5 });
    await handleGetTasks({});
    expect(mockGet).toHaveBeenCalled();
    // Reads go through planfixPost (full retry policy), never planfixMutate.
    expect(mockPost).toHaveBeenCalledWith("task/list", expect.anything());
    expect(mockMutate).not.toHaveBeenCalled();
  });
});

describe("safe mode ON — fail closed without a valid PLANFIX_TEST_PROJECT_ID", () => {
  const FAIL_CLOSED = /PLANFIX_TEST_PROJECT_ID is unset or not a positive integer/;

  for (const badValue of [undefined, "", "abc", "-5", "0", "12.5"]) {
    it(`refuses all mutating tools with PLANFIX_TEST_PROJECT_ID=${JSON.stringify(badValue)}`, async () => {
      enableSafeMode(badValue);
      const { handleCreateTask, handleUpdateTask } = await import("../src/tools/tasks.js");
      const { handleAddComment } = await import("../src/tools/comments.js");
      await expect(handleCreateTask({ name: "x", projectId: TEST_PROJECT })).rejects.toThrow(FAIL_CLOSED);
      await expect(handleUpdateTask({ taskId: 10, name: "x" })).rejects.toThrow(FAIL_CLOSED);
      await expect(handleAddComment({ taskId: 10, body: "x" })).rejects.toThrow(FAIL_CLOSED);
      // Fail-closed refusal happens before any HTTP traffic, including the resolve-GET.
      expect(mockMutate).not.toHaveBeenCalled();
      expect(mockGet).not.toHaveBeenCalled();
    });
  }

  it("contacts and file upload remain refused too", async () => {
    enableSafeMode(undefined);
    const { handleCreateContact, handleUpdateContact } = await import("../src/tools/contacts.js");
    const { handleUploadFileFromUrl } = await import("../src/tools/files.js");
    await expect(handleCreateContact({ name: "x" })).rejects.toThrow(/refused/);
    await expect(handleUpdateContact({ contactId: 1, name: "x" })).rejects.toThrow(/refused/);
    await expect(handleUploadFileFromUrl({ url: "https://x" })).rejects.toThrow(/refused/);
    expect(mockMutate).not.toHaveBeenCalled();
  });
});

describe("refusal messages never instruct the agent to disable the guard", () => {
  // The consumer is an LLM agent: a corrective action like "unset PLANFIX_SAFE_MODE"
  // is an instruction it may follow when stuck, defeating the guard's purpose.
  it("no refusal message contains 'unset PLANFIX_SAFE_MODE' or similar disable guidance", async () => {
    const { handleCreateTask, handleUpdateTask } = await import("../src/tools/tasks.js");
    const { handleAddComment } = await import("../src/tools/comments.js");
    const { handleCreateContact, handleUpdateContact } = await import("../src/tools/contacts.js");
    const { handleUploadFileFromUrl } = await import("../src/tools/files.js");
    const { handleAddTimeEntry } = await import("../src/tools/timeentries.js");
    const { handleAddChecklistItem, handleSetChecklistItemDone, handleUpdateChecklistItemName } = await import("../src/tools/checklists.js");

    const timeEntry = { taskId: 10, date: "2026-07-24", timeFrom: "10:00", timeTo: "10:30", type: "Task" as const, comment: "x", userId: 403 };

    const refusals: Array<() => Promise<string>> = [
      // fail-closed (no test project id)
      () => { enableSafeMode(undefined); return handleCreateTask({ name: "x", projectId: TEST_PROJECT }); },
      () => { enableSafeMode(undefined); return handleUpdateTask({ taskId: 10, name: "x" }); },
      () => { enableSafeMode(undefined); return handleAddTimeEntry(timeEntry); },
      () => { enableSafeMode(undefined); return handleAddChecklistItem({ taskId: 10, name: "x" }); },
      // wrong / missing project
      () => { enableSafeMode(String(TEST_PROJECT)); return handleCreateTask({ name: "x", projectId: OTHER_PROJECT }); },
      () => { enableSafeMode(String(TEST_PROJECT)); mockTaskInProject(OTHER_PROJECT); return handleUpdateTask({ taskId: 10, name: "x" }); },
      () => { enableSafeMode(String(TEST_PROJECT)); mockTaskInProject(OTHER_PROJECT); return handleAddComment({ taskId: 10, body: "x" }); },
      () => { enableSafeMode(String(TEST_PROJECT)); mockTaskInProject(OTHER_PROJECT); return handleAddTimeEntry(timeEntry); },
      () => { enableSafeMode(String(TEST_PROJECT)); mockTaskInProject(OTHER_PROJECT); return handleAddChecklistItem({ taskId: 10, name: "x" }); },
      () => { enableSafeMode(String(TEST_PROJECT)); mockTaskInProject(OTHER_PROJECT); return handleSetChecklistItemDone({ taskId: 10, itemId: 5, isDone: true }); },
      () => { enableSafeMode(undefined); return handleUpdateChecklistItemName({ taskId: 10, itemId: 5, name: "x" }); },
      () => { enableSafeMode(String(TEST_PROJECT)); mockTaskInProject(OTHER_PROJECT); return handleUpdateChecklistItemName({ taskId: 10, itemId: 5, name: "x" }); },
      // unscoped mutations
      () => { enableSafeMode(String(TEST_PROJECT)); return handleCreateContact({ name: "x" }); },
      () => { enableSafeMode(String(TEST_PROJECT)); return handleUpdateContact({ contactId: 5, name: "x" }); },
      () => { enableSafeMode(String(TEST_PROJECT)); return handleUploadFileFromUrl({ url: "https://x" }); },
    ];

    for (const trigger of refusals) {
      vi.unstubAllEnvs();
      vi.clearAllMocks();
      let message = "";
      await trigger().then(
        () => { throw new Error("expected a safe-mode refusal, but the call succeeded"); },
        (err: Error) => { message = err.message; },
      );
      expect(message).toContain("Safe mode:");
      expect(message).not.toMatch(/[а-яА-ЯёЁ]/); // English-errors rule (CLAUDE.md)
      expect(message).not.toContain("unset PLANFIX_SAFE_MODE");
      expect(message.toLowerCase()).not.toContain("disable the guard");
      expect(message.toLowerCase()).not.toMatch(/without (planfix_)?safe.mode/);
    }
  });
});

describe("safe mode activation edge cases", () => {
  it("unrecognized truthy values enable safe mode (fail safe)", async () => {
    const { isSafeModeOn } = await import("../src/safemode.js");
    for (const v of ["1", "true", "yes", "on", "banana"]) {
      vi.stubEnv("PLANFIX_SAFE_MODE", v);
      expect(isSafeModeOn(), `PLANFIX_SAFE_MODE=${JSON.stringify(v)}`).toBe(true);
    }
  });

  it("getTestProjectId parses only positive integers", async () => {
    const { getTestProjectId } = await import("../src/safemode.js");
    vi.stubEnv("PLANFIX_TEST_PROJECT_ID", "572465");
    expect(getTestProjectId()).toBe(572465);
    for (const v of ["", "abc", "-5", "0", "12.5", "1e3"]) {
      vi.stubEnv("PLANFIX_TEST_PROJECT_ID", v);
      expect(getTestProjectId(), `PLANFIX_TEST_PROJECT_ID=${JSON.stringify(v)}`).toBeNull();
    }
  });
});
