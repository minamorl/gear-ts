import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { Darkcore } from '@minamorl/berylx';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  CLOCK_RANDOM_TAG,
  HTTP_REQUEST_TAG,
  HTTP_OBSERVE_TAG,
  HttpAdapter,
  Port,
  PortAdapter,
  PortRegistry,
  Receipt,
  SHELL_RUN_TAG,
  ShellAdapter,
  TIME_NOW_TAG,
  TimeAdapter,
} from '../src/index.js';

describe('Port', () => {
  it('builds an unexecuted inspectable Darkcore effect', () => {
    const effect = ShellAdapter.effect(SHELL_RUN_TAG, { cmd: 'printf hi' });
    expect(effect).toBeInstanceOf(Darkcore.Effect);
    expect(effect.closed()).toBe(false);
    expect(effect).toMatchObject({ tag: SHELL_RUN_TAG, payload: { cmd: 'printf hi' } });
  });

  it('normalizes effect payloads to plain JSON data', () => {
    const effect = ShellAdapter.effect(SHELL_RUN_TAG, { cmd: 'printf hi' });
    expect(JSON.parse(JSON.stringify(effect.payload))).toEqual(effect.payload);
  });

  it('strictly rejects values that JSON.stringify would drop or coerce', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      undefined,
      () => undefined,
      Symbol('x'),
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(0),
      { missing: undefined },
      [undefined],
      cyclic,
    ]) {
      expect(() => Port.normalize(value)).toThrow(TypeError);
    }
  });

  it('returns a detached deeply frozen JSON value', () => {
    const source = { nested: { values: [1, 2] } };
    const normalized = Port.normalize(source) as typeof source;
    source.nested.values[0] = 9;

    expect(normalized).toEqual({ nested: { values: [1, 2] } });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.nested)).toBe(true);
    expect(Object.isFrozen(normalized.nested.values)).toBe(true);
  });

  it('validates without applying payload schema transforms or defaults to effect identity', () => {
    const adapter = new PortAdapter('identity').operation(
      'identity_probe',
      z.object({
        label: z.string().transform((label) => label.toUpperCase()),
        attempts: z.number().int().default(3),
      }),
      z.object({ ok: z.boolean() }),
      () => ({ ok: true }),
    );

    const effect = adapter.effect('identity_probe', { label: 'keep me' });

    expect(effect.payload).toEqual({ label: 'keep me' });
  });

  it('passes schema-parsed payload data to handlers without changing effect identity', async () => {
    const adapter = new PortAdapter('typed').operation(
      'typed_probe',
      z.object({
        label: z.string().transform((label) => label.toUpperCase()),
        attempts: z.number().int().default(3),
      }),
      z.object({ ok: z.boolean() }),
      () => ({ ok: true }),
    );
    const effect = adapter.effect('typed_probe', { label: 'keep me' });
    const interpret = vi.fn(() => ({ ok: true }));

    await Darkcore.runAsync(effect, adapter.handlers(interpret));

    expect(effect.payload).toEqual({ label: 'keep me' });
    expect(interpret).toHaveBeenCalledWith(
      expect.objectContaining({ tag: 'typed_probe' }),
      { label: 'KEEP ME', attempts: 3 },
    );
  });

  it('does not invoke a handler when its direct payload is invalid', async () => {
    const adapter = new PortAdapter('guarded').operation(
      'guarded_probe',
      z.object({ n: z.number().int() }),
      z.object({ ok: z.boolean() }),
      () => ({ ok: true }),
    );
    const interpret = vi.fn(() => ({ ok: true }));

    await expect(
      Darkcore.runAsync(Darkcore.op('guarded_probe', { n: 'bad' }, (value) => value), adapter.handlers(interpret)),
    ).rejects.toBeInstanceOf(Port.InvalidPayload);
    expect(interpret).not.toHaveBeenCalled();
  });

  it('interprets the same effect in real, fake, and dry categories', async () => {
    const effect = ShellAdapter.effect(SHELL_RUN_TAG, { cmd: "printf 'hi\\n'" });
    const real = (await Darkcore.runAsync(effect, ShellAdapter.realHandlers())) as Port.ShellResult;
    expect(real).toMatchObject({ exit_status: 0, stdout: 'hi\n' });

    const calls: unknown[] = [];
    const fake = ShellAdapter.handlers((operation, payload) => {
      calls.push([operation.tag, payload]);
      return { exit_status: 0, stdout: 'FAKE\n', stderr: '' };
    });
    expect(await Darkcore.runAsync(effect, fake)).toMatchObject({ stdout: 'FAKE\n' });
    expect(calls).toEqual([[SHELL_RUN_TAG, { cmd: "printf 'hi\\n'" }]]);

    const dry = ShellAdapter.handlers(() => ({ exit_status: 0, stdout: '', stderr: '' }));
    expect(await Darkcore.runAsync(effect, dry)).toMatchObject({ stdout: '' });
  });

  it('runs the real shell adapter', async () => {
    const effect = ShellAdapter.effect(SHELL_RUN_TAG, { cmd: "printf 'gear\\n'" });
    expect(await Darkcore.runAsync(effect, ShellAdapter.realHandlers())).toMatchObject({
      exit_status: 0,
      stdout: 'gear\n',
    });
  });

  it('captures nonzero shell status and stderr as a result', async () => {
    const effect = ShellAdapter.effect(SHELL_RUN_TAG, { cmd: "printf 'boom\\n' >&2; false" });
    expect(await Darkcore.runAsync(effect, ShellAdapter.realHandlers())).toEqual({
      exit_status: 1,
      stdout: '',
      stderr: 'boom\n',
    });
  });

  it('returns a statically typed Zod result shape', async () => {
    const effect = ShellAdapter.effect(SHELL_RUN_TAG, { cmd: 'true' });
    const result = (await Darkcore.runAsync(effect, ShellAdapter.realHandlers())) as Port.ShellResult;
    expect(Port.ShellResult.safeParse(result).success).toBe(true);
    expect(result).toHaveProperty('exit_status');
    expect(result).toHaveProperty('stdout');
    expect(result).toHaveProperty('stderr');
  });

  it('returns JSON-serializable results', async () => {
    const effect = ShellAdapter.effect(SHELL_RUN_TAG, { cmd: "printf 'hi\\n'" });
    const result = await Darkcore.runAsync(effect, ShellAdapter.realHandlers());
    expect(JSON.parse(JSON.stringify(result))).toEqual({ exit_status: 0, stdout: 'hi\n', stderr: '' });
  });

  it('rejects an invalid payload', () => {
    expect(() => ShellAdapter.effect(SHELL_RUN_TAG, { cmd: 123 })).toThrow(Port.InvalidPayload);
  });

  it('rejects an invalid result', async () => {
    const effect = ShellAdapter.effect(SHELL_RUN_TAG, { cmd: 'true' });
    const bad = ShellAdapter.handlers(() => ({ exit_status: 'oops' }));
    await expect(Darkcore.runAsync(effect, bad)).rejects.toBeInstanceOf(Port.InvalidResult);
  });

  it('looks adapters up by tag and name', () => {
    expect(Port.forTag(SHELL_RUN_TAG).name).toBe('shell');
    expect(Port.forTag(HTTP_REQUEST_TAG).name).toBe('http');
    expect(Port.adapter('shell')).toBe(ShellAdapter);
    expect(Port.forTag(TIME_NOW_TAG).name).toBe('time');
    expect(Port.adapter('time')).toBe(TimeAdapter);
    expect(Port.registry.tags).not.toContain(CLOCK_RANDOM_TAG);
  });

  it('builds an effect by discovering its adapter from the tag', () => {
    expect(Port.effect(SHELL_RUN_TAG, { cmd: 'true' }).tag).toBe(SHELL_RUN_TAG);
  });

  it('merges every registered adapter into one handler map', () => {
    expect(Object.keys(Port.realHandlers())).toEqual(
      expect.arrayContaining([SHELL_RUN_TAG, HTTP_REQUEST_TAG, TIME_NOW_TAG]),
    );
  });

  it('keeps wall-clock time behind a serializable time port', async () => {
    const adapter = Port.buildTimeAdapter(() => 42.5);
    const effect = adapter.effect(TIME_NOW_TAG, {});
    const result = await Darkcore.runAsync(effect, adapter.realHandlers());
    expect(result).toEqual({ epoch_seconds: 42.5 });
    expect(JSON.parse(JSON.stringify(result))).toEqual({ epoch_seconds: 42.5 });
  });

  it('raises for an unknown tag', () => {
    expect(() => Port.forTag('no_such_tag')).toThrow(Port.UnknownTag);
  });

  it('rejects tag conflicts during registration', () => {
    const registry = new PortRegistry();
    registry.register(ShellAdapter);
    const intruder = new PortAdapter('intruder').operation(
      SHELL_RUN_TAG,
      Port.ShellPayload,
      Port.ShellResult,
      () => ({ exit_status: 0, stdout: '', stderr: '' }),
    );
    expect(() => registry.register(intruder)).toThrow(Port.TagConflict);
  });

  it('rejects duplicate adapter names without changing either registry index', () => {
    const registry = new PortRegistry();
    const original = new PortAdapter('same').operation(
      'first', z.object({}), z.object({ ok: z.boolean() }), () => ({ ok: true }),
    );
    const replacement = new PortAdapter('same').operation(
      'second', z.object({}), z.object({ ok: z.boolean() }), () => ({ ok: true }),
    );
    registry.register(original);

    expect(() => registry.register(replacement)).toThrow(Port.DuplicateAdapter);
    expect(registry.adapter('same')).toBe(original);
    expect(registry.tags).toEqual(['first']);
    expect(() => registry.forTag('second')).toThrow(Port.UnknownTag);
  });

  it('keeps HTTP effect construction pure and inspectable', () => {
    const effect = HttpAdapter.effect(HTTP_REQUEST_TAG, {
      method: 'GET',
      url: 'http://example.test/',
    });
    expect(effect).toMatchObject({
      tag: HTTP_REQUEST_TAG,
      payload: { method: 'GET', url: 'http://example.test/' },
    });
  });

  it('validates a fake HTTP handler result', async () => {
    const effect = HttpAdapter.effect(HTTP_REQUEST_TAG, {
      method: 'GET',
      url: 'http://example.test/',
    });
    const fake = HttpAdapter.handlers(() => ({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'ok',
    }));
    const result = await Darkcore.runAsync(effect, fake);
    expect(Port.HttpResult.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ status: 200, body: 'ok' });
  });

  it('runs the real HTTP handler against a local server', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('hello from local');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('local server did not bind');
    try {
      const effect = HttpAdapter.effect(HTTP_REQUEST_TAG, {
        method: 'GET',
        url: `http://127.0.0.1:${address.port}/`,
      });
      const result = await Darkcore.runAsync(effect, HttpAdapter.realHandlers());
      expect(result).toMatchObject({
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: 'hello from local',
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('observes a written POST, a truncated body, and a complete response without retrying', async () => {
    const received: string[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        received.push(`${request.url}:${body}`);
        if (request.url === '/unknown') {
          request.socket.destroy();
        } else if (request.url === '/truncated') {
          response.writeHead(202, { 'content-type': 'text/plain', 'content-length': '100' });
          response.write('partial');
          setTimeout(() => response.destroy(), 20);
        } else if (request.url === '/misdirected') {
          response.writeHead(421);
          response.end('misdirected');
        } else if (request.url === '/encoded') {
          response.writeHead(200, { 'content-encoding': 'gzip' });
          response.end('encoded');
        } else if (request.url === '/transfer-encoded') {
          response.writeHead(200, { 'transfer-encoding': 'gzip, chunked' });
          response.end('encoded');
        } else if (request.url === '/not-modified') {
          response.writeHead(304, { 'content-encoding': 'gzip' });
          response.end();
        } else if (request.url === '/reset-content') {
          response.writeHead(205, { 'content-encoding': 'gzip', 'content-length': '0' });
          response.end();
        } else {
          response.writeHead(201, { 'content-type': 'text/plain' });
          response.end('created');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('local server did not bind');
    try {
      for (const [path, kind] of [['unknown', 'unknown'], ['truncated', 'body_unreadable'], ['ok', 'response'], ['misdirected', 'response']] as const) {
        const effect = HttpAdapter.effect(HTTP_OBSERVE_TAG, {
          method: 'POST', url: `http://127.0.0.1:${address.port}/${path}`, body: 'write',
        });
        const result = await Darkcore.runAsync(effect, HttpAdapter.realHandlers());
        expect(result).toMatchObject({ kind });
        if (path === 'truncated') expect(result).toMatchObject({ status: 202, headers: { 'content-type': 'text/plain' } });
        if (path === 'ok') expect(result).toMatchObject({ response: { status: 201, body: 'created' } });
        if (path === 'misdirected') expect(result).toMatchObject({ response: { status: 421, body: 'misdirected' } });
        const receipt = Receipt.issue({ effect, outcome: Receipt.ok(result), grounds: null, tick: 1 });
        expect(Receipt.fromJSON(receipt.serialize()).outcome).toEqual(Receipt.ok(result));
      }
      expect(received).toEqual(['/unknown:write', '/truncated:write', '/ok:write', '/misdirected:write']);
      const deletion = HttpAdapter.effect(HTTP_OBSERVE_TAG, {
        method: 'DELETE', url: `http://127.0.0.1:${address.port}/delete`, body: 'write',
      });
      expect(await Darkcore.runAsync(deletion, HttpAdapter.realHandlers())).toMatchObject({ kind: 'response' });
      expect(received.at(-1)).toBe('/delete:write');
      const encoded = HttpAdapter.effect(HTTP_OBSERVE_TAG, {
        method: 'GET', url: `http://127.0.0.1:${address.port}/encoded`,
      });
      expect(await Darkcore.runAsync(encoded, HttpAdapter.realHandlers())).toMatchObject({
        kind: 'body_unreadable', status: 200, headers: { 'content-encoding': 'gzip' },
      });
      const transferEncoded = HttpAdapter.effect(HTTP_OBSERVE_TAG, {
        method: 'GET', url: `http://127.0.0.1:${address.port}/transfer-encoded`,
      });
      expect(await Darkcore.runAsync(transferEncoded, HttpAdapter.realHandlers())).toMatchObject({
        kind: 'body_unreadable', status: 200, headers: { 'transfer-encoding': 'gzip, chunked' },
      });
      for (const [method, path, status] of [['HEAD', 'encoded', 200], ['GET', 'not-modified', 304], ['POST', 'reset-content', 205]] as const) {
        const effect = HttpAdapter.effect(HTTP_OBSERVE_TAG, { method, url: `http://127.0.0.1:${address.port}/${path}` });
        expect(await Darkcore.runAsync(effect, HttpAdapter.realHandlers())).toMatchObject({
          kind: 'response', response: { status, body: '', headers: { 'content-encoding': 'gzip' } },
        });
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects GET and HEAD bodies before sending and combines case-insensitive headers in order', async () => {
    const received: Array<{ method: string | undefined; accept: string | undefined }> = [];
    const server = createServer((request, response) => {
      received.push({ method: request.method, accept: request.headers.accept });
      response.writeHead(200);
      response.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('local server did not bind');
    try {
      const url = `http://127.0.0.1:${address.port}/`;
      for (const method of ['GET', 'HEAD'] as const) {
        for (const body of ['', 'write']) {
          const effect = HttpAdapter.effect(HTTP_OBSERVE_TAG, { method, url, body });
          expect(await Darkcore.runAsync(effect, HttpAdapter.realHandlers())).toEqual({ kind: 'unknown' });
        }
      }
      expect(received).toEqual([]);
      for (const method of ['GET', 'HEAD'] as const) {
        const effect = HttpAdapter.effect(HTTP_OBSERVE_TAG, {
          method, url, headers: { Accept: 'application/json', accept: 'text/plain' },
        });
        expect(await Darkcore.runAsync(effect, HttpAdapter.realHandlers())).toMatchObject({ kind: 'response' });
      }
      expect(received).toEqual([
        { method: 'GET', accept: 'application/json, text/plain' },
        { method: 'HEAD', accept: 'application/json, text/plain' },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('matches request body content type and UTF-8 BOM handling, and rejects URL credentials before sending', async () => {
    const received: Array<{ body: string; contentType: string | undefined }> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        received.push({ body, contentType: request.headers['content-type'] });
        response.writeHead(202, { 'content-type': 'application/json' });
        response.end(Buffer.from('\ufeff{"ok":true}', 'utf8'));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('local server did not bind');
    try {
      const url = `http://127.0.0.1:${address.port}/`;
      const rejected = HttpAdapter.effect(HTTP_OBSERVE_TAG, { method: 'POST', url: `http://user:password@127.0.0.1:${address.port}/`, body: 'write' });
      expect(await Darkcore.runAsync(rejected, HttpAdapter.realHandlers())).toEqual({ kind: 'unknown' });
      expect(received).toEqual([]);
      for (const [body, headers, expectedType] of [
        ['write', undefined, 'text/plain;charset=UTF-8'],
        ['', undefined, 'text/plain;charset=UTF-8'],
        ['write', { 'CoNtEnT-TyPe': 'application/custom' }, 'application/custom'],
        ['write', { 'CONTENT-TYPE': '' }, ''],
      ] as const) {
        const effect = HttpAdapter.effect(HTTP_OBSERVE_TAG, { method: 'POST', url, body, ...(headers ? { headers } : {}) });
        const result = Port.HttpObservation.parse(await Darkcore.runAsync(effect, HttpAdapter.realHandlers()));
        expect(result).toMatchObject({ kind: 'response', response: { status: 202, body: '{"ok":true}' } });
        if (result.kind === 'response') expect(JSON.parse(result.response.body)).toEqual({ ok: true });
        expect(received.at(-1)).toEqual({ body, contentType: expectedType });
      }
      expect(received).toHaveLength(4);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('negotiates identity by default and preserves explicit accept-encoding', async () => {
    const received: Array<{ encoding: string | undefined; body: string }> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        const encoding = request.headers['accept-encoding'];
        received.push({ encoding, body });
        if (encoding === 'identity' || encoding === '') {
          response.writeHead(201);
          response.end('created');
        } else {
          response.writeHead(201, { 'content-encoding': 'gzip' });
          response.end(gzipSync('created'));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('local server did not bind');
    try {
      for (const [headers, kind] of [[undefined, 'response'], [{ 'AcCePt-EnCoDiNg': 'gzip' }, 'body_unreadable'], [{ 'ACCEPT-ENCODING': '' }, 'response']] as const) {
        const payload = { method: 'POST', url: `http://127.0.0.1:${address.port}/`, body: 'write', ...(headers ? { headers } : {}) };
        const effect = HttpAdapter.effect(HTTP_OBSERVE_TAG, payload);
        expect(effect.payload).toEqual(payload);
        const result = await Darkcore.runAsync(effect, HttpAdapter.realHandlers());
        expect(result).toMatchObject(kind === 'response'
          ? { kind, response: { status: 201, body: 'created' } }
          : { kind, status: 201, headers: { 'content-encoding': 'gzip' } });
      }
      expect(received).toEqual([
        { encoding: 'identity', body: 'write' },
        { encoding: 'gzip', body: 'write' },
        { encoding: '', body: 'write' },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('closes an unsupported encoded response without draining an endless body', async () => {
    let closed!: () => void;
    const disconnected = new Promise<void>((resolve) => { closed = resolve; });
    const server = createServer((_request, response) => {
      response.on('close', closed);
      response.writeHead(200, { 'content-encoding': 'gzip' });
      response.write('incomplete');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('local server did not bind');
    try {
      const effect = HttpAdapter.effect(HTTP_OBSERVE_TAG, { method: 'GET', url: `http://127.0.0.1:${address.port}/` });
      expect(await Darkcore.runAsync(effect, HttpAdapter.realHandlers())).toMatchObject({ kind: 'body_unreadable' });
      await disconnected;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('resolves a protocol upgrade as the observed 101 response', async () => {
    const server = createServer();
    server.on('upgrade', (_request, socket) => {
      socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: example\r\n\r\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('local server did not bind');
    try {
      const effect = HttpAdapter.effect(HTTP_OBSERVE_TAG, {
        method: 'GET', url: `http://127.0.0.1:${address.port}/`, headers: { connection: 'Upgrade', upgrade: 'example' },
      });
      expect(await Darkcore.runAsync(effect, HttpAdapter.realHandlers())).toMatchObject({
        kind: 'response', response: { status: 101, headers: { upgrade: 'example' }, body: '' },
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('preserves custom fetch injection and legacy rejection', async () => {
    const error = new Error('transport');
    const adapter = Port.buildHttpAdapter(async () => { throw error; });
    const payload = { method: 'POST', url: 'http://example.test/', body: 'x' };
    await expect(Darkcore.runAsync(adapter.effect(HTTP_REQUEST_TAG, payload), adapter.realHandlers())).rejects.toBe(error);
    await expect(Darkcore.runAsync(adapter.effect(HTTP_OBSERVE_TAG, payload), adapter.realHandlers())).resolves.toEqual({ kind: 'unknown' });
    const fake = adapter.handlers(() => ({ kind: 'unknown' }));
    await expect(Darkcore.runAsync(adapter.effect(HTTP_OBSERVE_TAG, payload), fake)).resolves.toEqual({ kind: 'unknown' });
  });
});
