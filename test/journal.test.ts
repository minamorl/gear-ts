import { ControlSignal } from '@minamorl/berylx';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Journal, Tick } from '../src/index.js';

const runProgram = (
  boundary: Journal.RecordedBoundary,
  seed: number,
  outside: (port: string) => unknown,
) => {
  const time = boundary.call(1, 'clock', { zone: 'UTC' }, () => outside('clock'));
  const body = boundary.call(2, 'http', { url: '/x' }, () => outside('http'));
  const random = new Tick(seed, 1).rng().nextInt(1000);
  return { time, body, random, log: boundary.log };
};

describe('Journal', () => {
  it('appends into a new log and leaves the old log untouched', () => {
    const first = Journal.Entry.at(1, 'step', { n: 1 });
    const second = Journal.Entry.at(2, 'step', { n: 2 });
    const before = new Journal.Log([first]);
    const after = before.append(second);
    expect(before.size).toBe(1);
    expect(before.toArray()).toEqual([first]);
    expect(after.toArray()).toEqual([first, second]);
  });

  it('exposes no rewrite or delete API and freezes entries/logs', () => {
    const log = new Journal.Log([Journal.Entry.at(1, 'step', { n: 1 })]);
    const object = log as unknown as Record<string, unknown>;
    for (const name of ['delete', 'rewrite', 'update', 'clear', 'pop', 'shift', 'insert']) {
      expect(object[name]).toBeUndefined();
    }
    expect(Object.isFrozen(log)).toBe(true);
    expect(Object.isFrozen(log.toArray()[0])).toBe(true);
  });

  it('deep-clones and freezes entry payloads at append-only creation', () => {
    const source = { nested: { values: [1, 2] } };
    const entry = Journal.Entry.at(1, 'step', source);
    source.nested.values[0] = 99;

    expect(entry.payload).toEqual({ nested: { values: [1, 2] } });
    expect(Object.isFrozen(entry.payload.nested)).toBe(true);
    expect(Object.isFrozen((entry.payload.nested as { values: unknown }).values)).toBe(true);
  });

  it('derives current state by folding the journal', () => {
    const log = new Journal.Log([
      Journal.Entry.at(1, 'step', { n: 1 }),
      Journal.Entry.at(2, 'step', { n: 4 }),
      Journal.Entry.at(3, 'step', { n: 5 }),
    ]);
    expect(log.fold(0, (sum, entry) => sum + (entry.payload.n as number))).toBe(10);
  });

  it('folds deterministically from the same journal', () => {
    const log = new Journal.Log([
      Journal.Entry.at(1, 'step', { n: 3 }),
      Journal.Entry.at(2, 'step', { n: 7 }),
    ]);
    const reduce = (sum: number, entry: Journal.Entry) => sum + (entry.payload.n as number);
    expect(log.fold(0, reduce)).toBe(log.fold(0, reduce));
  });

  it('does not retain shadow state between folds', () => {
    const log = new Journal.Log([Journal.Entry.at(1, 'step', { n: 2 })]);
    expect(log.fold(0, (count) => count + 1)).toBe(1);
    expect(log.fold(0, (sum, entry) => sum + (entry.payload.n as number))).toBe(2);
  });

  it('records external results and replays without calling the outside world', () => {
    const recording = Journal.RecordedBoundary.recording();
    const first = runProgram(recording, 42, (port) => (port === 'clock' ? 1_722_000_000 : 'body'));
    expect(first.log.portResults().map((entry) => entry.payload.port)).toEqual(['clock', 'http']);

    const replay = Journal.RecordedBoundary.replaying(first.log);
    const second = runProgram(replay, 42, () => {
      throw new Error('replay touched the outside world');
    });
    expect(second).toMatchObject({ time: first.time, body: first.body, random: first.random });
  });

  it('makes deterministic replay depend on the seed too', () => {
    const recording = Journal.RecordedBoundary.recording();
    const first = runProgram(recording, 1, () => 0);
    const second = runProgram(Journal.RecordedBoundary.replaying(first.log), 2, () => {
      throw new Error('replay touched outside');
    });
    expect(second.random).not.toBe(first.random);
  });

  it('raises when replay crosses the recorded boundary', () => {
    const log = new Journal.Log([
      Journal.Entry.at(1, Journal.PORT_RESULT, { port: 'clock', request: null, result: 7 }),
    ]);
    const replay = Journal.RecordedBoundary.replaying(log);
    expect(replay.call(1, 'clock', () => 99)).toBe(7);
    let raised: unknown;
    try {
      replay.call(2, 'http', () => 99);
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(Journal.CrossedBoundary);
    expect(raised).toBeInstanceOf(Error);
    expect(raised).not.toBeInstanceOf(ControlSignal);
  });

  it('round-trips entries through NDJSON', () => {
    const log = new Journal.Log([
      Journal.Entry.at(1, 'step', { n: 1 }),
      Journal.Entry.at(2, Journal.PORT_RESULT, { port: 'clock', request: {}, result: 10 }),
    ]);
    const restored = Journal.load(Journal.dump(log));
    expect(restored.toArray()).toEqual(log.toArray());
    expect(restored.fold(0, (sum, entry) => sum + entry.tick)).toBe(
      log.fold(0, (sum, entry) => sum + entry.tick),
    );
  });

  it('writes one JSON object per nonblank line', () => {
    const log = new Journal.Log([
      Journal.Entry.at(1, 'step', { n: 1 }),
      Journal.Entry.at(2, 'step', { n: 2 }),
    ]);
    const lines = Journal.dump(log).split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toHaveLength(2);
  });

  it('matches replay on both port and request without consuming a mismatch', () => {
    const log = new Journal.Log([
      Journal.Entry.at(1, Journal.PORT_RESULT, {
        port: 'http',
        request: { method: 'GET', url: '/right' },
        result: 'right',
      }),
    ]);
    const replay = Journal.RecordedBoundary.replaying(log);
    expect(() => replay.call(1, 'http', { method: 'GET', url: '/wrong' }, () => 'live')).toThrow(
      Journal.ReplayMismatch,
    );
    expect(replay.call(1, 'http', { url: '/right', method: 'GET' }, () => 'live')).toBe('right');
  });

  it('raises a ControlSignal when a recorded result no longer matches its schema', () => {
    const log = new Journal.Log([
      Journal.Entry.at(1, Journal.PORT_RESULT, {
        port: 'shell',
        request: { cmd: 'true' },
        result: { exit_status: 'not-a-number' },
      }),
    ]);
    const replay = Journal.RecordedBoundary.replaying(log);
    const result = z.object({ exit_status: z.number().int() });
    let raised: unknown;
    try {
      replay.call(1, 'shell', { cmd: 'true' }, () => ({ exit_status: 0 }), result);
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(Journal.ReplayUnreadable);
    expect(raised).toBeInstanceOf(ControlSignal);
  });

  it('records and replays asynchronous port results through the same boundary', async () => {
    const schema = z.object({ status: z.number().int(), body: z.string() });
    const recording = Journal.RecordedBoundary.recording();
    const first = await recording.callAsync(
      1,
      'http',
      { method: 'GET', url: '/async' },
      async () => ({ status: 200, body: 'recorded' }),
      schema,
    );
    expect(first).toEqual({ status: 200, body: 'recorded' });

    const replay = Journal.RecordedBoundary.replaying(recording.log);
    const second = await replay.callAsync(
      1,
      'http',
      { url: '/async', method: 'GET' },
      async () => {
        throw new Error('replay touched outside');
      },
      schema,
    );
    expect(second).toEqual(first);
  });

  it('skips blank NDJSON lines and reports the malformed line number', () => {
    const valid = JSON.stringify({ tick: 1, kind: 'step', payload: { n: 1 } });
    expect(Journal.load(`\n${valid}\n \n`).size).toBe(1);
    expect(() => Journal.load(`${valid}\n\n{bad}\n`)).toThrow(/line 3/u);
  });
});
