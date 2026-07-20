/**
 * Injectable HTTP transport for connector adapters. The real implementation
 * uses global fetch; tests inject a mock so no network is touched. Adapters
 * never construct their own fetch calls — everything goes through this seam,
 * which keeps auth injection, error mapping, and testing in one place.
 */

export type HttpRequest = {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  url: string;
  headers: Record<string, string>;
  /** Serialized request body (already JSON-encoded), if any. */
  body?: string;
};

export type HttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

/** Production transport over global fetch. Never logs headers (Bearer tokens). */
export const fetchTransport: HttpTransport = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body !== undefined ? { body: req.body } : {}),
  });
  const text = await res.text();
  let body: unknown = text;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: res.status, headers, body };
};
