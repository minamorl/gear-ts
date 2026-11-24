import { z } from 'zod';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Adapter } from './core.js';

export const HTTP_REQUEST_TAG = 'http_request' as const;
export const HTTP_OBSERVE_TAG = 'http_observe' as const;
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

export const HttpObservation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('response'), response: HttpResult }),
  z.object({ kind: z.literal('unknown') }),
  z.object({
    kind: z.literal('body_unreadable'),
    status: z.number().int(),
    headers: z.record(z.string(), z.string()),
  }),
]);
export type HttpObservation = z.infer<typeof HttpObservation>;

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

// Unlike Fetch, Node's HTTP request does not follow redirects or retry a 421.
const singleRequest: Fetch = (url, init) => new Promise((resolve, reject) => {
  const target = new URL(url);
  if (target.username || target.password) throw new TypeError('URL credentials are not supported');
  if ((init.method === 'GET' || init.method === 'HEAD') && init.body !== undefined) {
    throw new TypeError('GET and HEAD requests cannot have a body');
  }
  const send = target.protocol === 'http:' ? httpRequest : target.protocol === 'https:' ? httpsRequest : null;
  if (!send) throw new TypeError('unsupported HTTP protocol');
  const headers = new Headers();
  for (const [name, value] of Object.entries(init.headers ?? {})) headers.append(name, value);
  if (!headers.has('accept-encoding')) {
    headers.set('accept-encoding', 'identity');
  }
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'text/plain;charset=UTF-8');
  }
  if (init.body !== undefined && !headers.has('content-length') && !headers.has('transfer-encoding')) {
    headers.set('content-length', String(Buffer.byteLength(init.body)));
  }
  const requestHeaders: Record<string, string> = {};
  headers.forEach((value, name) => { requestHeaders[name] = value; });
  const req = send(target, { method: init.method, headers: requestHeaders }, (res) => {
    const headers = Object.entries(res.headers).flatMap(([name, value]): [string, string][] =>
      value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]],
    );
    resolve({
      status: res.statusCode!,
      headers: { entries: () => headers },
      async text() {
        const bodyless = init.method === 'HEAD' || res.statusCode === 204 || res.statusCode === 205 || res.statusCode === 304;
        const transferEncoding = res.headers['transfer-encoding']?.toLowerCase().split(',').map((v) => v.trim()) ?? [];
        const unsupportedTransfer = transferEncoding.some((value) => value !== 'chunked');
        if (!bodyless && (unsupportedTransfer || (res.headers['content-encoding'] && res.headers['content-encoding'].toLowerCase() !== 'identity'))) {
          res.destroy();
          throw new Error('unsupported content encoding');
        }
        const chunks: Buffer[] = [];
        for await (const chunk of res) chunks.push(Buffer.from(chunk));
        return new TextDecoder().decode(Buffer.concat(chunks));
      },
    });
  });
  req.on('upgrade', (res, socket) => {
    const headers = Object.entries(res.headers).flatMap(([name, value]): [string, string][] =>
      value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]],
    );
    socket.destroy();
    resolve({ status: res.statusCode!, headers: { entries: () => headers }, text: async () => '' });
  });
  req.on('error', reject);
  req.end(init.body);
});

function request(payload: HttpPayload, fetch: Fetch): Promise<FetchResponse> {
  return fetch(payload.url, {
    method: payload.method,
    headers: payload.headers,
    body: payload.body ?? undefined,
  });
}

export async function performHttp(payload: HttpPayload, fetch: Fetch = nodeFetch()): Promise<HttpResult> {
  const response = await request(payload, fetch);
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  };
}

export async function observeHttp(payload: HttpPayload, fetch: Fetch = singleRequest): Promise<HttpObservation> {
  let response: FetchResponse;
  try {
    response = await request(payload, fetch);
  } catch {
    return { kind: 'unknown' };
  }
  const status = response.status;
  const headers = Object.fromEntries(response.headers.entries());
  try {
    return { kind: 'response', response: { status, headers, body: await response.text() } };
  } catch {
    return { kind: 'body_unreadable', status, headers };
  }
}

export function buildHttpAdapter(fetch?: Fetch): Adapter {
  const legacyFetch = fetch ?? nodeFetch();
  return new Adapter('http')
    .asyncOperation(HTTP_REQUEST_TAG, HttpPayload, HttpResult, (payload) => performHttp(payload, legacyFetch))
    .asyncOperation(HTTP_OBSERVE_TAG, HttpPayload, HttpObservation, (payload) => observeHttp(payload, fetch ?? singleRequest));
}

export const HttpAdapter = buildHttpAdapter();
export const Http = Object.freeze({
  TAG: HTTP_REQUEST_TAG,
  OBSERVE_TAG: HTTP_OBSERVE_TAG,
  PAYLOAD: HttpPayload,
  RESULT: HttpResult,
  OBSERVATION: HttpObservation,
  build: buildHttpAdapter,
  ADAPTER: HttpAdapter,
});
