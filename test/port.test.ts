import { createServer } from 'node:http';
import { Darkcore } from '@minamorl/berylx';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  CLOCK_RANDOM_TAG,
  HTTP_REQUEST_TAG,
  HttpAdapter,
  Port,
  PortAdapter,
  PortRegistry,
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
      Darkcore.runAsync(Darkcore.op('guarded_probe', { n: 'bad' }), adapter.handlers(interpret)),
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
});
