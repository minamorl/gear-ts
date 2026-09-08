import { readFileSync } from 'node:fs';
import { Err, Ok, Task, type BerylxNode } from '@minamorl/berylx';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Admission,
  Executor,
  Journal,
  JournalEntry,
  JournalLog,
  PortAdapter,
  PortRegistry,
  Routine,
  VERSION,
} from '../src/index.js';

const ProbePayload = z.object({ n: z.number().int() });
const ProbeResult = z.object({ n: z.number().int(), doubled: z.number().int() });
type ProbeResult = z.infer<typeof ProbeResult>;

const allow = () => new Admission.AllowAll();
const deny = () => new Admission.DenyAll();

function registryWithProbe(calls: number[]): PortRegistry {
  const registry = new PortRegistry();
  registry.register(new PortAdapter('probe').operation('probe', ProbePayload, ProbeResult, (payload) => {
    calls.push(payload.n);
    return { n: payload.n, doubled: payload.n * 2 };
  }));
  return registry;
}

function mixedRegistry(calls: number[]): PortRegistry {
  const registry = registryWithProbe(calls);
  registry.register(new PortAdapter('shell').operation(
    'shell_run',
    z.object({ cmd: z.string() }),
    z.object({ stdout: z.string() }),
    ({ cmd }) => ({ stdout: `${cmd}\n` }),
  ));
  return registry;
}

function probeTask(name: string, key: string, number: number): Task {
  return Task.of(name, (lay, io) => {
    const result = io.perform('probe', { n: number }) as ProbeResult;
    return lay.put(key, result.doubled);
  });
}

function shellTask(name: string, key: string, cmd: string): Task {
  return Task.of(name, (lay, io) => {
    const result = io.perform('shell_run', { cmd }) as { stdout: string };
    return lay.put(key, result.stdout);
  });
}

function twoProbes(): BerylxNode {
  return probeTask('double_a', 'a', 2).then(probeTask('double_b', 'b', 3));
}

function effectSequence(journal: Journal.Log): unknown[] {
  return journal.toArray()
    .filter((entry) => entry.kind === 'receipt')
    .map((entry) => {
      const effect = entry.payload.effect as Record<string, unknown>;
      return [effect.tag, effect.payload];
    });
}

async function record(program: BerylxNode, registry: PortRegistry, seed = 1) {
  return Executor.run(program, { policy: allow(), seed, registry });
}

describe('Routine', () => {
  it('restores a routine from a real run', async () => {
    const out = await record(twoProbes(), registryWithProbe([]));

    const routine = Routine.fromJournal(out.journal, { name: 'double_pair' });

    expect(routine.name).toBe('double_pair');
    expect(routine.steps).toHaveLength(2);
    expect(routine.steps.map((step) => step.tag)).toEqual(['probe', 'probe']);
    expect(routine.steps.map((step) => step.payload)).toEqual([{ n: 2 }, { n: 3 }]);
  });

  it('replays a restored routine with the same effect sequence', async () => {
    const originalCalls: number[] = [];
    const original = await record(twoProbes(), registryWithProbe(originalCalls));
    const routine = Routine.fromJournal(original.journal, { name: 'double_pair' });

    const replayCalls: number[] = [];
    const replay = await Executor.run(routine.toTask(), {
      policy: allow(),
      seed: 99,
      registry: registryWithProbe(replayCalls),
    });

    expect(originalCalls).toEqual([2, 3]);
    expect(replayCalls).toEqual([2, 3]);
    expect(effectSequence(replay.journal)).toEqual(effectSequence(original.journal));
  });

  it('passes a restored routine through admission', async () => {
    const out = await record(probeTask('solo', 'a', 7), registryWithProbe([]));
    const routine = Routine.fromJournal(out.journal, { name: 'solo' });
    const calls: number[] = [];

    const denied = await routine.run({
      policy: deny(),
      seed: 1,
      registry: registryWithProbe(calls),
    });

    expect(calls).toEqual([]);
    expect(denied.result).toBeInstanceOf(Err);
    expect(denied.journal.toArray().filter((entry) => entry.kind === 'admission_denied')).toHaveLength(1);
    expect(denied.receipts).toEqual([]);
  });

  it('emits grounded, chained receipts when restored', async () => {
    const out = await record(twoProbes(), registryWithProbe([]));
    const routine = Routine.fromJournal(out.journal, { name: 'double_pair' });

    const run = await routine.run({ policy: allow(), seed: 1, registry: registryWithProbe([]) });

    expect(run.receipts).toHaveLength(2);
    for (const receipt of run.receipts) {
      expect(receipt.succeeded).toBe(true);
      expect(receipt.grounded).toBe(true);
    }
    expect(run.receipts[0]?.predecessor).toBeNull();
    expect(run.receipts[1]?.predecessor).toBe(run.receipts[0]?.id);
  });

  it('awaits an async restored step and receipts it before the run resolves', async () => {
    const source = new JournalLog().append(JournalEntry.at(1, 'receipt', {
      effect: { tag: 'delayed_probe', payload: { n: 5 } },
    }));
    const routine = Routine.fromJournal(source, { name: 'delayed' });
    let release: ((value: ProbeResult) => void) | undefined;
    const registry = new PortRegistry();
    registry.register(
      new PortAdapter('delayed').asyncOperation(
        'delayed_probe',
        ProbePayload,
        ProbeResult,
        () => new Promise((resolve) => { release = resolve; }),
      ),
    );
    let settled = false;
    const running = routine.run({ policy: allow(), seed: 1, registry })
      .then((outcome) => { settled = true; return outcome; });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(release).toBeTypeOf('function');
    release?.({ n: 5, doubled: 10 });
    const out = await running;

    expect(settled).toBe(true);
    expect(out.result).toBeInstanceOf(Ok);
    expect(out.receipts).toHaveLength(1);
    expect(out.receipts[0]?.effect.tag).toBe('delayed_probe');
    expect(out.journal.portResults()).toHaveLength(1);
  });

  it('extracts a tick selection', async () => {
    const out = await record(twoProbes(), registryWithProbe([]));
    const second = Routine.fromJournal(out.journal, {
      name: 'only_second',
      ticks: new Set([2]),
    });

    expect(second.steps).toHaveLength(1);
    expect(second.steps[0]?.payload).toEqual({ n: 3 });

    const calls: number[] = [];
    await second.run({ policy: allow(), seed: 1, registry: registryWithProbe(calls) });
    expect(calls).toEqual([3]);
    expect(second.slice({ ticks: [99] }).steps).toEqual([]);
  });

  it('extracts by tag', async () => {
    const program = probeTask('p', 'a', 4).then(shellTask('s', 'b', 'echo gear'));
    const out = await record(program, mixedRegistry([]));

    const onlyShell = Routine.fromJournal(out.journal, { name: 'only_shell', tags: ['shell_run'] });
    const onlyProbe = Routine.fromJournal(out.journal, { name: 'only_probe', tags: ['probe'] });

    expect(onlyShell.steps.map((step) => step.tag)).toEqual(['shell_run']);
    expect(onlyProbe.steps.map((step) => step.tag)).toEqual(['probe']);
    expect(onlyShell.steps[0]?.payload).toEqual({ cmd: 'echo gear' });
    expect(Routine.fromJournal(out.journal, { name: 'all' }).slice({ tags: ['probe'] }).steps)
      .toEqual(onlyProbe.steps);
  });

  it('runs a parameterized routine with a different argument', async () => {
    const out = await record(probeTask('solo', 'a', 2), registryWithProbe([]));
    const routine = Routine.fromJournal(out.journal, { name: 'doubler' });
    const parameterized = routine.parameterize({ num: { key: 'n' } });

    expect(parameterized.params).toEqual(['num']);
    expect(parameterized.parameterized).toBe(true);

    const calls: number[] = [];
    await parameterized.run({
      policy: allow(),
      seed: 1,
      params: { num: 42 },
      registry: registryWithProbe(calls),
    });
    expect(calls).toEqual([42]);
    expect(() => parameterized.toTask()).toThrow(/routine doubler is missing parameters: num/u);
  });

  it('round-trips serialized routines, including holes', async () => {
    const out = await record(twoProbes(), registryWithProbe([]));
    const routine = Routine.fromJournal(out.journal, { name: 'double_pair' });

    expect(Routine.load(routine.dump()).toJSON()).toEqual(routine.toJSON());

    const parameterized = routine.parameterize({ num: { key: 'n', step: 0 } });
    const reloaded = Routine.load(parameterized.dump());
    expect(reloaded.toJSON()).toEqual(parameterized.toJSON());
    expect(reloaded.params).toEqual(['num']);
    expect(() => Routine.load('{"name": 3, "steps": []}')).toThrow();
  });

  it('uses receipt encounter order, includes failed receipts, and excludes results and denials', () => {
    const journal = new JournalLog()
      .append(JournalEntry.at(9, 'receipt', {
        effect: { tag: 'failed', payload: { n: 9 } },
        outcome: { status: 'err', reason: 'boom' },
      }))
      .append(JournalEntry.at(99, Journal.PORT_RESULT, { port: 'ignored' }))
      .append(JournalEntry.at(8, 'admission_denied', { tag: 'denied', reason: 'no' }))
      .append(JournalEntry.at(1, 'receipt', {
        effect: { tag: 'later_in_journal', payload: { n: 1 } },
      }));

    const routine = Routine.fromJournal(journal, { name: 'ordered' });

    expect(routine.steps.map((step) => [step.tick, step.tag])).toEqual([
      [9, 'failed'],
      [1, 'later_in_journal'],
    ]);
  });

  it('recognizes only exact one-key holes and substitutes recursively', () => {
    const value = {
      list: [{ [Routine.HOLE]: 'first' }],
      not_a_hole: {
        [Routine.HOLE]: 'literal',
        nested: { [Routine.HOLE]: 'second' },
      },
    };

    expect(Routine.holeNames(value)).toEqual(['first', 'second']);
    expect(Routine.substitute(value, { first: 1, second: 2 })).toEqual({
      list: [1],
      not_a_hole: { [Routine.HOLE]: 'literal', nested: 2 },
    });
    expect(() => Routine.substitute({ [Routine.HOLE]: 'missing' }, {}))
      .toThrow(/routine parameter was not supplied: missing/u);
  });

  it('runs an empty routine as a normal no-op Task', async () => {
    const routine = new Routine.Definition({ name: 'nothing' });
    const task = routine.toTask();
    expect(task).toBeInstanceOf(Task);
    expect((task as Task).effectful()).toBe(false);
    expect(task.call({ untouched: true })).toBeInstanceOf(Ok);

    const out = await routine.run({ policy: allow(), seed: 1 });

    expect(VERSION).toBe(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    expect(out.result).toBeInstanceOf(Ok);
    expect(out.receipts).toEqual([]);
    expect(out.lastTick).toBe(0);
  });
});
