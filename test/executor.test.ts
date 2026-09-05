import { AsyncTask, Err, Ok, Task } from '@minamorl/berylx';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Admission,
  CLOCK_RANDOM_TAG,
  Executor,
  Journal,
  Kit,
  Port,
  PortAdapter,
  PortRegistry,
  ReplayMismatch,
  ReplayUnreadable,
  SHELL_RUN_TAG,
  TIME_NOW_TAG,
} from '../src/index.js';

const ProbePayload = z.object({ n: z.number().int() });
const ProbeResult = z.object({ n: z.number().int(), doubled: z.number().int() });
type ProbeResult = z.infer<typeof ProbeResult>;

const allow = () => new Admission.AllowAll();
const deny = () => new Admission.DenyAll();

function registryWithProbe(calls: number[]): PortRegistry {
  const adapter = new PortAdapter('probe').operation(
    'probe',
    ProbePayload,
    ProbeResult,
    (payload) => {
      calls.push(payload.n);
      return { n: payload.n, doubled: payload.n * 2 };
    },
  );
  const registry = new PortRegistry();
  registry.register(adapter);
  return registry;
}

function probeTask(name: string, key: string, number: number): Task {
  return Task.of(name, (lay, io) => {
    const result = io.perform('probe', { n: number }) as ProbeResult;
    return lay.put(key, result.doubled);
  });
}

function twoProbes() {
  return probeTask('double_a', 'a', 2).then(probeTask('double_b', 'b', 3));
}

function randomTask(name: string, key: string, bound = 1_000_000): Task {
  return Task.of(name, (lay, io) => {
    const result = io.perform(CLOCK_RANDOM_TAG, { bound }) as { value: number };
    return lay.put(key, result.value);
  });
}

function mixedRandomAndPorts() {
  return randomTask('random_a', 'random_a')
    .then(probeTask('probe_a', 'probe_a', 2))
    .then(randomTask('random_b', 'random_b'))
    .then(probeTask('probe_b', 'probe_b', 3));
}

function okFocus(outcome: Executor.Outcome): Record<string, unknown> {
  expect(outcome.result).toBeInstanceOf(Ok);
  if (!(outcome.result instanceof Ok)) throw new Error('expected Ok');
  return outcome.result.focus.toObject() as Record<string, unknown>;
}

describe('Executor', () => {
  it('runs berylx task composition with a real shell', async () => {
    const greet = AsyncTask.of('greet', async (lay, io) => {
      const result = (await io.perform(SHELL_RUN_TAG, { cmd: 'echo gear' })) as Port.ShellResult;
      return lay.put('greeting', result.stdout);
    });

    const out = await Executor.run(greet, { policy: allow(), seed: 1 });

    expect(okFocus(out).greeting).toBe('gear\n');
    expect(out.receipts).toHaveLength(1);
    expect(out.receipts[0]?.succeeded).toBe(true);
    expect(out.suspended).toBe(false);
  });

  it('runs multi-step composition', async () => {
    const calls: number[] = [];
    const out = await Executor.run(twoProbes(), {
      policy: allow(),
      seed: 1,
      registry: registryWithProbe(calls),
    });

    expect(okFocus(out)).toEqual({ a: 4, b: 6 });
    expect(calls).toEqual([2, 3]);
  });

  it('never fires a denied effect and records the denial', async () => {
    const calls: number[] = [];
    const out = await Executor.run(probeTask('solo', 'a', 2), {
      policy: deny(),
      seed: 5,
      registry: registryWithProbe(calls),
    });

    expect(calls).toEqual([]);
    expect(out.result).toBeInstanceOf(Err);
    if (!(out.result instanceof Err)) throw new Error('expected Err');
    expect(out.result.cause).toBeInstanceOf(Executor.AdmissionDenied);
    const denials = out.journal.toArray().filter((entry) => entry.kind === 'admission_denied');
    expect(denials).toHaveLength(1);
    expect(denials[0]?.payload.by).toBe('deny_all');
    expect(out.receipts).toEqual([]);
  });

  it('emits a chained receipt for every executed effect', async () => {
    const out = await Executor.run(twoProbes(), {
      policy: allow(),
      seed: 9,
      registry: registryWithProbe([]),
    });
    const receiptsInJournal = out.journal.toArray().filter((entry) => entry.kind === 'receipt');

    expect(receiptsInJournal).toHaveLength(out.journal.portResults().length);
    expect(out.receipts).toHaveLength(2);
    for (const receipt of out.receipts) {
      expect(receipt.grounded).toBe(true);
      expect(receipt.succeeded).toBe(true);
      expect(receipt.effect.tag).toBeTruthy();
    }
    expect(out.receipts[0]?.predecessor).toBeNull();
    expect(out.receipts[1]?.predecessor).toBe(out.receipts[0]?.id);
  });

  it('interrupts then resumes to the same final state', async () => {
    const fullCalls: number[] = [];
    const full = await Executor.run(twoProbes(), {
      policy: allow(),
      seed: 3,
      registry: registryWithProbe(fullCalls),
    });
    expect(fullCalls).toEqual([2, 3]);

    const partCalls: number[] = [];
    const partial = await Executor.run(twoProbes(), {
      policy: allow(),
      seed: 3,
      registry: registryWithProbe(partCalls),
      maxEffects: 1,
    });
    expect(partial.suspended).toBe(true);
    expect(partCalls).toEqual([2]);
    expect(partial.journal.portResults()).toHaveLength(1);

    const resumeCalls: number[] = [];
    const resumed = await Executor.run(twoProbes(), {
      policy: allow(),
      seed: 3,
      registry: registryWithProbe(resumeCalls),
      journal: partial.journal,
    });
    expect(resumed.suspended).toBe(false);
    expect(resumeCalls).toEqual([3]);
    expect(okFocus(resumed)).toEqual(okFocus(full));
    expect(resumed.receipts).toEqual(full.receipts);
  });

  it('replays deterministically from the same journal and seed', async () => {
    const recordCalls: number[] = [];
    const recorded = await Executor.run(twoProbes(), {
      policy: allow(),
      seed: 7,
      registry: registryWithProbe(recordCalls),
    });
    const replayCalls: number[] = [];
    const replayed = await Executor.run(twoProbes(), {
      policy: allow(),
      seed: 7,
      registry: registryWithProbe(replayCalls),
      journal: recorded.journal,
    });

    expect(recordCalls).toEqual([2, 3]);
    expect(replayCalls).toEqual([]);
    expect(replayed.receipts).toEqual(recorded.receipts);
    expect(Journal.dump(replayed.journal)).toBe(Journal.dump(recorded.journal));
  });

  it('reruns only effects beyond the recorded replay boundary', async () => {
    const seedRun = await Executor.run(twoProbes(), {
      policy: allow(),
      seed: 4,
      registry: registryWithProbe([]),
      maxEffects: 1,
    });
    const calls: number[] = [];
    const out = await Executor.run(twoProbes(), {
      policy: allow(),
      seed: 4,
      registry: registryWithProbe(calls),
      journal: seedRun.journal,
    });

    expect(calls).toEqual([3]);
    expect(okFocus(out)).toEqual({ a: 4, b: 6 });
  });

  it('repeats random effects from the same seed without port results', async () => {
    const first = await Executor.run(randomTask('draw', 'draw'), { policy: allow(), seed: 12_345 });
    const second = await Executor.run(randomTask('draw', 'draw'), { policy: allow(), seed: 12_345 });
    expect(first.journal.portResults()).toEqual([]);
    expect(second.journal.portResults()).toEqual([]);
    expect(okFocus(first).draw).toBe(okFocus(second).draw);
  });

  it('changes random values with the seed and receipts the drawn value', async () => {
    const first = await Executor.run(randomTask('draw', 'draw'), { policy: allow(), seed: 1 });
    const second = await Executor.run(randomTask('draw', 'draw'), { policy: allow(), seed: 2 });
    expect(okFocus(first).draw).not.toBe(okFocus(second).draw);
    expect(first.receipts).toHaveLength(1);
    expect((first.receipts[0]?.outcome as { value: { value: number } }).value.value).toBe(okFocus(first).draw);
    expect(first.receipts[0]?.effect.tag).toBe(CLOCK_RANDOM_TAG);
  });

  it('draws nothing for a denied random effect and records denial', async () => {
    const out = await Executor.run(randomTask('draw', 'draw'), { policy: deny(), seed: 9 });
    expect(out.result).toBeInstanceOf(Err);
    expect(out.receipts).toEqual([]);
    expect(out.journal.portResults()).toEqual([]);
    const denial = out.journal.toArray().find((entry) => entry.kind === 'admission_denied');
    expect(denial?.payload.tag).toBe(CLOCK_RANDOM_TAG);
  });

  it('does not shift the port replay cursor for random effects', async () => {
    const partialCalls: number[] = [];
    const partial = await Executor.run(mixedRandomAndPorts(), {
      policy: allow(),
      seed: 77,
      registry: registryWithProbe(partialCalls),
      maxEffects: 3,
    });
    expect(partial.suspended).toBe(true);
    expect(partialCalls).toEqual([2]);
    expect(partial.journal.portResults()).toHaveLength(1);

    const resumeCalls: number[] = [];
    const resumed = await Executor.run(mixedRandomAndPorts(), {
      policy: allow(),
      seed: 77,
      registry: registryWithProbe(resumeCalls),
      journal: partial.journal,
    });
    const full = await Executor.run(mixedRandomAndPorts(), {
      policy: allow(),
      seed: 77,
      registry: registryWithProbe([]),
    });
    expect(resumeCalls).toEqual([3]);
    expect(okFocus(resumed)).toEqual(okFocus(full));
    expect(resumed.receipts).toEqual(full.receipts);
  });

  it('records and replays the time port without reading the clock again', async () => {
    const program = Task.of('now', (lay, io) => {
      const result = io.perform(TIME_NOW_TAG, {}) as { epoch_seconds: number };
      return lay.put('now', result.epoch_seconds);
    });
    const firstRegistry = new PortRegistry();
    firstRegistry.register(Port.buildTimeAdapter(() => 123.25));
    const recorded = await Executor.run(program, { policy: allow(), seed: 6, registry: firstRegistry });
    const replayRegistry = new PortRegistry();
    replayRegistry.register(Port.buildTimeAdapter(() => { throw new Error('replay read clock'); }));
    const replayed = await Executor.run(program, {
      policy: allow(), seed: 6, registry: replayRegistry, journal: recorded.journal,
    });

    expect(recorded.journal.portResults()[0]?.payload).toMatchObject({
      port: TIME_NOW_TAG,
      result: { epoch_seconds: 123.25 },
    });
    expect(okFocus(replayed).now).toBe(okFocus(recorded).now);
    expect(recorded.receipts).toHaveLength(1);
    expect(recorded.receipts[0]).toMatchObject({
      grounded: true,
      outcome: { status: 'ok', value: { epoch_seconds: 123.25 } },
    });
  });

  it('does not read the external clock when the time port is denied', async () => {
    const program = Task.of('now', (lay, io) => {
      const result = io.perform(TIME_NOW_TAG, {}) as { epoch_seconds: number };
      return lay.put('now', result.epoch_seconds);
    });
    const registry = new PortRegistry();
    const now = vi.fn(() => 1);
    registry.register(Port.buildTimeAdapter(now));
    const out = await Executor.run(program, { policy: deny(), seed: 6, registry });
    expect(out.result).toBeInstanceOf(Err);
    expect(now).not.toHaveBeenCalled();
    expect(out.journal.toArray().filter((entry) => entry.kind === 'admission_denied')).toHaveLength(1);
    expect(out.receipts).toEqual([]);
  });

  it('raises on replay against a diverging effect order', async () => {
    const registry = sameShapeRegistry();
    const recorded = await Executor.run(
      sameShapeTask('alpha', 'a').then(sameShapeTask('beta', 'b')),
      { policy: allow(), seed: 1, registry },
    );
    expect(okFocus(recorded)).toEqual({ a: 4, b: 20 });
    let raised: unknown;
    try {
      await Executor.run(sameShapeTask('beta', 'b').then(sameShapeTask('alpha', 'a')), {
        policy: allow(), seed: 1, registry: sameShapeRegistry(), journal: recorded.journal,
      });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(ReplayMismatch);
    expect(raised).toMatchObject({ tick: 1, recordedPort: 'alpha', requestedTag: 'beta' });
    expect((raised as ReplayMismatch).message).toMatch(
      /tick 1: the journal recorded alpha but the program requested beta/u,
    );
  });

  it('still reads back replay with the same effect order', async () => {
    const program = sameShapeTask('alpha', 'a').then(sameShapeTask('beta', 'b'));
    const recorded = await Executor.run(program, { policy: allow(), seed: 1, registry: sameShapeRegistry() });
    const replayed = await Executor.run(program, {
      policy: allow(), seed: 1, registry: sameShapeRegistry(), journal: recorded.journal,
    });
    expect(replayed.receipts).toEqual(recorded.receipts);
    expect(okFocus(replayed)).toEqual({ a: 4, b: 20 });
  });

  it('makes the Kit declaration readable from the program', async () => {
    let seen: unknown;
    const program = Task.of('reads_kit', (lay, io) => {
      seen = lay.at(Kit.FOCUS_KEY).fetch();
      const result = io.perform('probe', { n: 2 }) as ProbeResult;
      return lay.put('doubled', result.doubled);
    });
    const out = await Executor.run(program, {
      policy: allow(), seed: 1, registry: registryWithProbe([]), kit: Kit.of({ ports: ['probe'] }),
    });
    expect(seen).toEqual({ ports: ['probe'], programs: [], depth: 0 });
    expect(okFocus(out).doubled).toBe(4);
  });

  it('caps an allowing policy with the Kit', async () => {
    const calls: number[] = [];
    const out = await Executor.run(probeTask('capped', 'a', 2), {
      policy: allow(),
      seed: 1,
      registry: registryWithProbe(calls),
      kit: Kit.of({ ports: ['something_else'] }),
    });
    expect(calls).toEqual([]);
    expect(out.result).toBeInstanceOf(Err);
    const denied = out.journal.toArray().filter((entry) => entry.kind === 'admission_denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]?.payload.reason).toMatch(/was not handed down/u);
    expect(denied[0]?.payload.by).toBe('by_kit');
  });

  it('changes nothing when no Kit is supplied', async () => {
    const calls: number[] = [];
    const out = await Executor.run(probeTask('plain', 'a', 2), {
      policy: allow(), seed: 1, registry: registryWithProbe(calls),
    });
    expect(calls).toEqual([2]);
    expect(okFocus(out).a).toBe(4);
  });

  it('matches replay on the payload as well as the port tag', async () => {
    const recorded = await Executor.run(probeTask('probe', 'a', 2), {
      policy: allow(), seed: 1, registry: registryWithProbe([]),
    });
    await expect(Executor.run(probeTask('probe', 'a', 3), {
      policy: allow(), seed: 1, registry: registryWithProbe([]), journal: recorded.journal,
    })).rejects.toBeInstanceOf(ReplayMismatch);
  });

  it('raises unreadable replay as a ControlSignal outside the Task result', async () => {
    const journal = new Journal.Log([
      Journal.Entry.at(1, Journal.PORT_RESULT, {
        port: 'probe', request: { n: 2 }, result: { n: 'bad', doubled: 4 },
      }),
    ]);
    let raised: unknown;
    try {
      await Executor.run(probeTask('probe', 'a', 2), {
        policy: allow(), seed: 1, registry: registryWithProbe([]), journal,
      });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(ReplayUnreadable);
    expect(raised).toMatchObject({ tick: 1, tag: 'probe' });
    expect((raised as ReplayUnreadable).violations.length).toBeGreaterThan(0);
  });

  it('issues a failed receipt after an admitted external operation throws', async () => {
    const calls: number[] = [];
    const registry = new PortRegistry();
    registry.register(new PortAdapter('probe').operation('probe', ProbePayload, ProbeResult, (payload) => {
      calls.push(payload.n);
      throw new Error('external boom');
    }));
    const out = await Executor.run(probeTask('boom', 'a', 2), {
      policy: allow(), seed: 1, registry,
    });
    expect(out.result).toBeInstanceOf(Err);
    expect(calls).toEqual([2]);
    expect(out.journal.portResults()).toEqual([]);
    expect(out.journal.toArray().filter((entry) => entry.kind === 'effect_failed')).toHaveLength(1);
    expect(out.receipts).toHaveLength(1);
    expect(out.receipts[0]?.succeeded).toBe(false);
  });

  it('rejects a marked async port from a sync Task before admission or execution', async () => {
    const run = vi.fn(async (payload: { n: number }) => ({
      n: payload.n,
      doubled: payload.n * 2,
    }));
    const registry = new PortRegistry();
    registry.register(
      new PortAdapter('async_probe').asyncOperation(
        'async_probe', ProbePayload, ProbeResult, run,
      ),
    );
    const task = Task.of('sync_caller', (lay, io) => {
      io.perform('async_probe', { n: 2 });
      return lay;
    });

    const out = await Executor.run(task, { policy: allow(), seed: 1, registry });

    expect(out.result).toBeInstanceOf(Err);
    expect(run).not.toHaveBeenCalled();
    expect(out.lastTick).toBe(0);
    expect(out.journal.toArray()).toEqual([]);
    expect(out.receipts).toEqual([]);
  });

  it('joins every async branch before a suspension escapes', async () => {
    let release: ((value: { n: number; doubled: number }) => void) | undefined;
    let secondStarted = false;
    const registry = new PortRegistry();
    registry.register(new PortAdapter('slow').asyncOperation(
      'slow', ProbePayload, ProbeResult,
      (payload) => new Promise((resolve) => { release = resolve; }),
    ));
    registry.register(new PortAdapter('second').operation(
      'second', ProbePayload, ProbeResult,
      (payload) => ({ n: payload.n, doubled: payload.n * 2 }),
    ));
    const slow = AsyncTask.of('slow', async (lay, io) => {
      await io.perform('slow', { n: 1 });
      return lay.put('slow', true);
    });
    const second = AsyncTask.of('second', async (lay, io) => {
      secondStarted = true;
      await io.perform('second', { n: 2 });
      return lay.put('second', true);
    });
    let settled = false;
    const running = Executor.run(slow.par(second), {
      policy: allow(), seed: 1, registry, maxEffects: 1,
    }).then((outcome) => { settled = true; return outcome; });
    await Promise.resolve();
    expect(secondStarted).toBe(true);
    expect(settled).toBe(false);
    expect(release).toBeTypeOf('function');
    release?.({ n: 1, doubled: 2 });
    const out = await running;
    expect(out.suspended).toBe(true);
    expect(out.receipts).toHaveLength(1);
    expect(out.receipts[0]?.effect.tag).toBe('slow');
  });
});

function sameShapeRegistry(): PortRegistry {
  const registry = new PortRegistry();
  for (const [name, factor] of [['alpha', 2], ['beta', 10]] as const) {
    registry.register(new PortAdapter(name).operation(name, ProbePayload, ProbeResult, (payload) => ({
      n: payload.n,
      doubled: payload.n * factor,
    })));
  }
  return registry;
}

function sameShapeTask(tag: string, key: string): Task {
  return Task.of(tag, (lay, io) => {
    const result = io.perform(tag, { n: 2 }) as ProbeResult;
    return lay.put(key, result.doubled);
  });
}
