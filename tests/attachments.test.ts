// ROADMAP P12: file attachments — uploadLocalFile guards, attach_file_to_task,
// add_comment files param, read-side rendering. The fetch-level multipart shape
// of planfixUploadFile is asserted in tests/upload-client.test.ts (this file
// mocks the client module, which would clobber the real implementation).
// Shapes mirror docs/spikes/file-attachments.md.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CYRILLIC = /[а-яА-ЯёЁ]/;

// ── uploadLocalFile guards + the two attach tools (client mocked) ─────────────

vi.mock("../src/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client.js")>();
  return { ...actual, planfixPost: vi.fn(), planfixGet: vi.fn(), planfixMutate: vi.fn(), planfixUploadFile: vi.fn() };
});

import { planfixPost, planfixGet, planfixMutate, planfixUploadFile } from "../src/client.js";

const mockPost = vi.mocked(planfixPost);
const mockMutate = vi.mocked(planfixMutate);
const mockGet = vi.mocked(planfixGet);
const mockUpload = vi.mocked(planfixUploadFile);

let dir: string;
let smallFile: string;

describe("uploadLocalFile guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "planfix-mcp-test-"));
    smallFile = join(dir, "файл.txt");
    writeFileSync(smallFile, "hello");
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("uploads a valid absolute path using the basename as the filename", async () => {
    mockUpload.mockResolvedValue({ result: "success", id: 42 });
    const { uploadLocalFile } = await import("../src/tools/files.js");
    const r = await uploadLocalFile(smallFile);
    expect(r).toEqual({ id: 42, name: "файл.txt" });
    expect(mockUpload).toHaveBeenCalledWith("файл.txt", expect.any(Uint8Array));
  });

  it("refuses relative paths, missing files, and directories with actionable English", async () => {
    const { uploadLocalFile } = await import("../src/tools/files.js");
    await expect(uploadLocalFile("relative/path.txt")).rejects.toThrow(/must be absolute/);
    await expect(uploadLocalFile(join(dir, "nope.txt"))).rejects.toThrow(/File not found/);
    const sub = join(dir, "subdir");
    mkdirSync(sub);
    await expect(uploadLocalFile(sub)).rejects.toThrow(/is a directory/);
    expect(mockUpload).not.toHaveBeenCalled();
    for (const p of ["relative/path.txt"]) {
      const err = await import("../src/tools/files.js").then((m) => m.uploadLocalFile(p)).catch((e: Error) => e);
      expect((err as Error).message).not.toMatch(CYRILLIC);
    }
  });

  it("refuses files over the 50 MB tool cap, naming it a tool limit", async () => {
    const bigFile = join(dir, "big.bin");
    writeFileSync(bigFile, Buffer.alloc(51 * 1024 * 1024)); // real 51 MB file; removed in afterEach
    const { uploadLocalFile } = await import("../src/tools/files.js");
    await expect(uploadLocalFile(bigFile)).rejects.toThrow(/51 MB.*caps uploads at 50 MB.*tool limit, not an API fact/);
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

describe("attach_file_to_task", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "planfix-mcp-test-"));
    smallFile = join(dir, "report.docx");
    writeFileSync(smallFile, "doc");
    mockGet.mockResolvedValue({ file: { id: 42, name: "report.docx", size: 1 } });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("requires exactly one source (zero and two both refuse before any call)", async () => {
    const { handleAttachFileToTask } = await import("../src/tools/files.js");
    await expect(handleAttachFileToTask({ taskId: 1 })).rejects.toThrow(/EXACTLY ONE source.*got 0/);
    await expect(handleAttachFileToTask({ taskId: 1, fileId: 5, url: "https://x.com/a" })).rejects.toThrow(/EXACTLY ONE source.*got 2/);
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("localPath: uploads then attaches via the dedicated endpoint with the task id as a query param", async () => {
    mockUpload.mockResolvedValue({ result: "success", id: 42 });
    mockMutate.mockResolvedValue({ result: "success" });
    const { handleAttachFileToTask } = await import("../src/tools/files.js");
    const out = await handleAttachFileToTask({ taskId: 123, localPath: smallFile });
    expect(mockUpload).toHaveBeenCalledWith("report.docx", expect.any(Uint8Array));
    expect(mockMutate).toHaveBeenCalledWith("file/42/attach/task?id=123");
    expect(out).toContain("✓ File #42");
    expect(out).toContain("(1 KB)");
    expect(out).toContain("attached to task 123");
  });

  it("url: uploads via file/from-url/ then attaches; name override forwarded", async () => {
    mockMutate
      .mockResolvedValueOnce({ result: "success", id: 77 })  // from-url
      .mockResolvedValueOnce({ result: "success" });          // attach
    mockGet.mockResolvedValue({ file: { id: 77, name: "r.pdf", size: 3 } });
    const { handleAttachFileToTask } = await import("../src/tools/files.js");
    const out = await handleAttachFileToTask({ taskId: 9, url: "https://example.com/r.pdf", name: "r.pdf" });
    expect(mockMutate).toHaveBeenNthCalledWith(1, "file/from-url/", { url: "https://example.com/r.pdf", name: "r.pdf" });
    expect(mockMutate).toHaveBeenNthCalledWith(2, "file/77/attach/task?id=9");
    expect(out).toContain("✓ File #77");
  });

  it("fileId: attaches directly with no upload call", async () => {
    mockMutate.mockResolvedValue({ result: "success" });
    const { handleAttachFileToTask } = await import("../src/tools/files.js");
    const out = await handleAttachFileToTask({ taskId: 9, fileId: 1729843 });
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockMutate).toHaveBeenCalledWith("file/1729843/attach/task?id=9");
    expect(out).toContain("existing Planfix file");
  });

  it("propagates the code-41 unsafe-url failure from the from-url leg", async () => {
    mockMutate.mockRejectedValueOnce(new Error("Planfix API error 41: Unsafe url for downloading file"));
    const { handleAttachFileToTask } = await import("../src/tools/files.js");
    await expect(handleAttachFileToTask({ taskId: 9, url: "https://planfix.com/favicon.ico" }))
      .rejects.toThrow("error 41");
  });
});

describe("add_comment with files", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "planfix-mcp-test-"));
    smallFile = join(dir, "звіт.docx");
    writeFileSync(smallFile, "doc");
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("uploads paths, passes fileIds through, sends files: [{id}] in the comment body", async () => {
    mockUpload.mockResolvedValue({ result: "success", id: 42 });
    mockMutate.mockResolvedValue({ result: "success", id: 900 });
    const { handleAddComment } = await import("../src/tools/comments.js");
    const out = await handleAddComment({ taskId: 123, body: "Report attached.", files: [smallFile, 1729843] });
    expect(mockMutate).toHaveBeenCalledWith("task/123/comments/", {
      description: "Report attached.",
      files: [{ id: 42 }, { id: 1729843 }],
    });
    expect(out).toContain("✓ Comment created, ID: 900");
    expect(out).toContain('#42 "звіт.docx"');
    expect(out).toContain("#1729843");
  });

  it("without files the body carries no files key (backward compatible)", async () => {
    mockMutate.mockResolvedValue({ result: "success", id: 901 });
    const { handleAddComment } = await import("../src/tools/comments.js");
    await handleAddComment({ taskId: 123, body: "plain" });
    expect(mockMutate).toHaveBeenCalledWith("task/123/comments/", { description: "plain" });
  });

  it("a bad path refuses BEFORE the comment is created", async () => {
    const { handleAddComment } = await import("../src/tools/comments.js");
    await expect(handleAddComment({ taskId: 123, body: "x", files: [join(dir, "missing.pdf")] }))
      .rejects.toThrow(/File not found/);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("schema caps files at 10 and rejects empty strings", async () => {
    const { addCommentSchema } = await import("../src/tools/comments.js");
    expect(addCommentSchema.safeParse({ taskId: 1, body: "x", files: Array.from({ length: 11 }, () => "C:\\a.txt") }).success).toBe(false);
    expect(addCommentSchema.safeParse({ taskId: 1, body: "x", files: [""] }).success).toBe(false);
    expect(addCommentSchema.safeParse({ taskId: 1, body: "x", files: ["C:\\a.txt", 5] }).success).toBe(true);
  });
});

describe("read-side rendering", () => {
  it("comment rows render attached files as name (#id, N KB); CONCISE omits them", async () => {
    const f = await import("../src/format.js");
    const resp = { comments: [{ id: 1, description: "text", files: [{ id: 1729845, size: 2048, name: "тест-файл-2мб.bin" }] }] };
    const out = f.formatCommentList(resp, 50, 0, false);
    expect(out).toContain("file: тест-файл-2мб.bin (#1729845, 2048 KB)");
  });

  it("formatFile renders KB size and the expiring downloadUrl", async () => {
    const f = await import("../src/format.js");
    const out = f.formatFile({ file: { id: 9, name: "a.txt", size: 1, downloadUrl: "https://s3/x?X-Amz-Expires=3600" } });
    expect(out).toContain("size: 1 KB");
    expect(out).toContain("downloadUrl (expires, fetch fresh): https://s3/x");
    expect(out).not.toMatch(CYRILLIC);
  });
});
