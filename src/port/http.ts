import { z } from 'zod';
import { Adapter } from './core.js';

export const HTTP_REQUEST_TAG = 'http_request' as const;
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;

export const HttpPayload = z.object({
  method: z.enum(HTTP_METHODS),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().nullish(),
});

export const HttpResult = z.object({
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});

export type HttpPayload = z.infer<typeof HttpPayload>;
export type HttpResult = z.infer<typeof HttpResult>;

interface FetchResponse {
  readonly status: number;
  readonly headers: { entries(): Iterable<[string, string]> };
  text(): Promise<string>;
}

type Fetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  },
) => Promise<FetchResponse>;

function nodeFetch(): Fetch {
  return (globalThis as unknown as { readonly fetch: Fetch }).fetch;
}

export async function performHttp(payload: HttpPayload, fetch: Fetch = nodeFetch()): Promise<HttpResult> {
  const response = await fetch(payload.url, {
    method: payload.method,
    headers: payload.headers,
    body: payload.body ?? undefined,
  });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  };
}

export function buildHttpAdapter(fetch: Fetch = nodeFetch()): Adapter {
  return new Adapter('http').asyncOperation(HTTP_REQUEST_TAG, HttpPayload, HttpResult, (payload) =>
    performHttp(payload, fetch),
  );
}

export const HttpAdapter = buildHttpAdapter();
export const Http = Object.freeze({
  TAG: HTTP_REQUEST_TAG,
  PAYLOAD: HttpPayload,
  RESULT: HttpResult,
  build: buildHttpAdapter,
  ADAPTER: HttpAdapter,
});
