const TIMEOUT = 15_000;
const MAX_RETRIES = 3;

/** Logical rate-limit code in Planfix `{result:"fail"}` envelopes (retryable). */
const RATE_LIMIT_CODE = 22;

function getBaseUrl(): string {
  const account = process.env.PLANFIX_ACCOUNT;
  if (!account) {
    throw new Error(
      "PLANFIX_ACCOUNT is not set — the account subdomain (e.g. `mycompany` from mycompany.planfix.com). " +
      "The subdomain is required: the Planfix REST API has no shared host; the entry point is https://<account>.planfix.com/rest/.",
    );
  }
  // Allow a custom host suffix for regional installs (e.g. PLANFIX_HOST=planfix.ru).
  const host = process.env.PLANFIX_HOST || "planfix.com";
  return `https://${account}.${host}/rest`;
}

function getAuthHeader(): string {
  const apiKey = process.env.PLANFIX_API_KEY;
  if (apiKey) return `Bearer ${apiKey}`;

  const token = process.env.PLANFIX_TOKEN;
  if (token) return `Bearer ${token}`;

  throw new Error(
    "No API key is set. Set PLANFIX_API_KEY (or the legacy PLANFIX_TOKEN). " +
    "The key is created in Account Management → API Access → REST API.",
  );
}

function isFailEnvelope(parsed: unknown): parsed is { result: "fail"; code?: number; error?: string } {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as Record<string, unknown>).result === "fail"
  );
}

export async function planfixRequest(
  method: "GET" | "POST",
  endpoint: string,
  body?: Record<string, unknown>,
  // retryTransient=false (mutating call sites): 5xx and timeouts are NOT
  // retried — the server may have committed the write before failing to
  // answer, and a retry would double-create (audit E1). HTTP-429 and logical
  // code-22 stay retryable in both modes: they are pre-commit refusals.
  opts: { retryTransient?: boolean } = {},
): Promise<unknown> {
  const retryTransient = opts.retryTransient !== false;
  const auth = getAuthHeader();
  const baseUrl = getBaseUrl();
  // Preserve a meaningful trailing slash (Planfix documents `POST /task/` and
  // `.../comments/`); only strip a leading slash to avoid a double slash on join.
  const url = `${baseUrl}/${endpoint.replace(/^\/+/, "")}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);

    try {
      const options: RequestInit = {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: auth,
        },
        signal: controller.signal,
      };
      if (body && method === "POST") {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);
      clearTimeout(timer);

      if (response.ok) {
        const text = await response.text();
        const parsed = text ? JSON.parse(text) : {};

        // Planfix returns HTTP 2xx even for some logical failures — inspect the
        // `result` field so a `{result:"fail"}` body is never mistaken for success.
        if (isFailEnvelope(parsed)) {
          const code = parsed.code;
          const errMsg = parsed.error ?? "unknown error";
          if (code === RATE_LIMIT_CODE && attempt < MAX_RETRIES) {
            const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
            console.error(`[planfix-mcp] rate limit (code 22), retrying in ${delay}ms (${attempt}/${MAX_RETRIES})`);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          throw new Error(`Planfix API error ${code ?? "?"}: ${errMsg}`);
        }

        return parsed;
      }

      const transientHttp = response.status >= 500;
      if ((response.status === 429 || (transientHttp && retryTransient)) && attempt < MAX_RETRIES) {
        const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
        console.error(`[planfix-mcp] ${response.status}, retrying in ${delay}ms (${attempt}/${MAX_RETRIES})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      const errBody = await response.text().catch(() => "");
      const noRetryNote = transientHttp && !retryTransient
        ? " NOT retried (mutating request — the server may have committed the write; verify before retrying)."
        : "";
      throw new Error(`Planfix HTTP ${response.status}: ${response.statusText} ${errBody}`.trim() + noRetryNote);
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof DOMException && error.name === "AbortError") {
        if (retryTransient && attempt < MAX_RETRIES) {
          console.error(`[planfix-mcp] Timeout, retrying (${attempt}/${MAX_RETRIES})`);
          continue;
        }
        if (!retryTransient) {
          throw new Error(
            `Planfix request timed out after ${TIMEOUT / 1000}s and was NOT retried (mutating request — ` +
            "the server may have committed the write; verify before retrying).",
          );
        }
      }
      throw error;
    }
  }
  throw new Error("Planfix API: all retry attempts exhausted");
}

/** POST shorthand for READ-shaped endpoints (list/search) — full retry policy. */
export async function planfixPost(endpoint: string, body: Record<string, unknown> = {}): Promise<unknown> {
  return planfixRequest("POST", endpoint, body);
}

/**
 * POST for MUTATING endpoints (create/update/attach/datatag writes).
 * A separate entry point rather than a flag: the retry policy is then visible
 * and greppable at every write site, and a forgotten flag cannot silently
 * reinstate the unsafe default. Policy (audit E1): 429 + code-22 retry
 * (pre-commit refusals); 5xx and timeouts surface immediately — the tools'
 * "writes are NEVER retried automatically" promise is literal.
 */
export async function planfixMutate(endpoint: string, body: Record<string, unknown> = {}): Promise<unknown> {
  return planfixRequest("POST", endpoint, body, { retryTransient: false });
}

/** Multipart uploads get a longer window than the JSON default (large files). */
const UPLOAD_TIMEOUT = 120_000;

/**
 * Multipart file upload: `POST /file/` with the single binary form field `file`
 * (shape verified live, docs/spikes/file-attachments.md). Single attempt — an
 * upload is not safely retryable without risking a duplicate file. File
 * contents are never logged.
 */
export async function planfixUploadFile(filename: string, data: Uint8Array): Promise<unknown> {
  const auth = getAuthHeader();
  const baseUrl = getBaseUrl();
  const form = new FormData();
  form.append("file", new Blob([data as BlobPart]), filename);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT);
  try {
    // No Content-Type header: fetch sets the multipart boundary itself.
    const response = await fetch(`${baseUrl}/file/`, {
      method: "POST",
      headers: { Authorization: auth },
      body: form,
      signal: controller.signal,
    });
    const text = await response.text();
    // ok-check BEFORE parsing: a non-JSON error body (e.g. an HTML 502 page)
    // must surface as the HTTP error, not a SyntaxError (audit E2).
    if (!response.ok) {
      throw new Error(`Planfix HTTP ${response.status}: ${response.statusText} ${text}`.trim());
    }
    const parsed = text ? JSON.parse(text) : {};
    if (isFailEnvelope(parsed)) {
      throw new Error(`Planfix API error ${parsed.code ?? "?"}: ${parsed.error ?? "unknown error"}`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`File upload timed out after ${UPLOAD_TIMEOUT / 1000}s: ${filename}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** GET shorthand with optional query parameters (e.g. `{ fields: "id,name" }`). */
export async function planfixGet(
  endpoint: string,
  query?: Record<string, string | number | undefined>,
): Promise<unknown> {
  let ep = endpoint;
  if (query) {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    if (qs) ep += (ep.includes("?") ? "&" : "?") + qs;
  }
  return planfixRequest("GET", ep);
}
