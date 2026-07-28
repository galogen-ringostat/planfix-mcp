// ROADMAP P12: planfixUploadFile multipart shape, asserted at the fetch level
// against the REAL client implementation (tests/attachments.test.ts mocks the
// client module, so these assertions live in their own file).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("planfixUploadFile (multipart, real client)", () => {
  beforeEach(() => {
    vi.stubEnv("PLANFIX_ACCOUNT", "testacc");
    vi.stubEnv("PLANFIX_API_KEY", "testkey");
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("POSTs FormData with the single binary field `file` and the given (Cyrillic-safe) filename", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: "success", id: 1729845 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { planfixUploadFile } = await import("../src/client.js");

    const resp = await planfixUploadFile("тест-файл.bin", new Uint8Array([1, 2, 3]));
    expect(resp).toMatchObject({ id: 1729845 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://testacc.planfix.com/rest/file/");
    expect(init.method).toBe("POST");
    // No manual Content-Type — fetch must set the multipart boundary itself.
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer testkey");
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const entries = [...form.entries()];
    expect(entries).toHaveLength(1);
    const [field, value] = entries[0];
    expect(field).toBe("file");
    expect((value as File).name).toBe("тест-файл.bin");
    expect((value as File).size).toBe(3);
  });

  it("throws on a fail envelope with the Planfix code, never retrying the upload", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: "fail", code: 41, error: "Unsafe url for downloading file" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { planfixUploadFile } = await import("../src/client.js");
    await expect(planfixUploadFile("x.txt", new Uint8Array(1))).rejects.toThrow("Planfix API error 41");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on HTTP error status with the status in the message", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 413, statusText: "Payload Too Large" }));
    vi.stubGlobal("fetch", fetchMock);
    const { planfixUploadFile } = await import("../src/client.js");
    await expect(planfixUploadFile("x.txt", new Uint8Array(1))).rejects.toThrow("Planfix HTTP 413");
  });
});
