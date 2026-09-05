import { AsyncTask, Err, Ok, Task } from '@minamorl/berylx';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Admission,
  BoundaryError,
  ChildFailed,
  Executor,
  Journal,
  Kit,
  PROGRAM_SUBMIT_TAG,
  PortAdapter,
  PortRegistry,
  ProgramRegistry,
  TooDeep,
} from '../src/index.js';

const ProbeIn = z.object({ n: z.number().int() }).describe('ProbeIn');
const ProbeOut = z.object({ n: z.number().int(), doubled: z.number().int() }).describe('ProbeOut');

const allow = () => new Admission.AllowAll();

function ports(calls: number[]): PortRegistry {
  const registry = new PortRegistry();
  registry.register(
    new PortAdapter('probe').operation('probe', ProbeIn, ProbeOut, (payload) => {
      calls.push(payload.n);
      return { n: payload.n, doubled: payload.n * 2 };
    }),
  );
  return registry;
}

function childTask(): Task {
  return Task.of('double', (lay, io) => {
    const n = lay.at('n').fetch() as number;
    const result = io.perform('probe', { n }) as { doubled: number };
    return lay.put('doubled', result.doubled);
  });
}

function programs(): ProgramRegistry {
  return new ProgramRegistry().register({
    name: 'double', task: childTask(), input: ProbeIn, output: ProbeOut,
  });
}

function parent(name = 'double', value: unknown = 2): Task {
  return Task.of('parent', (lay, io) => {
    const output = io.perform(PROGRAM_SUBMIT_TAG, { name, focus: { n: value } }) as {
      doubled: number;
    };
    return lay.put('from_child', output.doubled);
  });
}

function peekTask(report: (declaration: Record<string, unknown>) => void): Task {
  return Task.of('peek', (lay, _io) => {
    report(lay.at(Kit.FOCUS_KEY).fetch() as Record<string, unknown>);
    return lay.put('doubled', 0);
  });
}

function kit(depth = 1): Kit {
  return Kit.of({ ports: ['probe', PROGRAM_SUBMIT_TAG], programs: ['double'], depth });
}

async function runParent(options: {
  readonly kit?: Kit | null;
  readonly calls?: number[];
  readonly name?: string;
  readonly value?: unknown;
  readonly journal?: Journal.Log;
  readonly maxEffects?: number;
} = {}): Promise<Executor.Outcome> {
  return Executor.run(parent(options.name, options.value), {
    policy: allow(),
    seed: 1,
    registry: ports(options.calls ?? []),
    programs: programs(),
    kit: options.kit === undefined ? kit() : options.kit,
    journal: options.journal,
    maxEffects: options.maxEffects,
  });
}

function resultFocus(outcome: Executor.Outcome): Record<string, unknown> {
  expect(outcome.result).toBeInstanceOf(Ok);
  if (!(outcome.result instanceof Ok)) throw new Error('expected Ok');
  return outcome.result.focus.toObject() as Record<string, unknown>;
}

describe('program_submit', () => {
  it('runs the child inline on the parent total order', async () => {
    const calls: number[] = [];
    const out = await runParent({ calls });
    expect(calls).toEqual([2]);
    expect(resultFocus(out).from_child).toBe(4);
    expect(out.journal.portResults()).toHaveLength(1);
    expect(out.journal.portResults()[0]?.payload.port).toBe('probe');
    expect(out.receipts).toHaveLength(2);
    expect(out.journal.toArray().map((entry) => entry.kind)).toContain('receipt');
  });

  it('chains receipts in completion order across the submit boundary', async () => {
    const [child, submit] = (await runParent()).receipts;
    expect(child?.effect.tag).toBe('probe');
    expect(submit?.effect.tag).toBe(PROGRAM_SUBMIT_TAG);
    expect(submit?.tick).toBe(1);
    expect(child?.tick).toBe(2);
    expect(child?.predecessor).toBeNull();
    expect(submit?.predecessor).toBe(child?.id);
  });

  it('hands the child a narrowed Kit', async () => {
    let seen: Record<string, unknown> | undefined;
    const registry = new ProgramRegistry().register({
      name: 'peek',
      task: peekTask((declaration) => { seen = declaration; }),
      input: ProbeIn,
      output: ProbeOut,
    });
    await Executor.run(parent('peek'), {
      policy: allow(),
      seed: 1,
      registry: ports([]),
      programs: registry,
      kit: Kit.of({ ports: ['probe', PROGRAM_SUBMIT_TAG], programs: ['peek'], depth: 2 }),
    });
    expect(seen?.depth).toBe(1);
    expect(seen?.ports).toEqual(['probe', PROGRAM_SUBMIT_TAG].sort());
  });

  it('does not let depth zero submit', async () => {
    const calls: number[] = [];
    const out = await runParent({ kit: kit(0), calls });
    expect(calls).toEqual([]);
    expect(out.result).toBeInstanceOf(Err);
    const denied = out.journal.toArray().filter((entry) => entry.kind === 'admission_denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]?.payload.reason).toMatch(/depth is exhausted/u);
  });

  it('does not submit a program that was not handed down', async () => {
    const calls: number[] = [];
    const out = await runParent({
      kit: Kit.of({ ports: ['probe', PROGRAM_SUBMIT_TAG], programs: ['other'], depth: 1 }),
      calls,
    });
    expect(calls).toEqual([]);
    const denied = out.journal.toArray().find((entry) => entry.kind === 'admission_denied');
    expect(denied?.payload.reason).toMatch(/program double was not handed down/u);
  });

  it('does not let an unregistered program ride the machine', async () => {
    const out = await runParent({
      name: 'ghost',
      kit: Kit.of({ ports: ['probe', PROGRAM_SUBMIT_TAG], programs: ['ghost'], depth: 1 }),
    });
    expect(out.result).toBeInstanceOf(Err);
  });

  it('refuses input that violates the declared boundary before running the child', async () => {
    const calls: number[] = [];
    const out = await runParent({ value: 'two', calls });
    expect(calls).toEqual([]);
    expect(out.result).toBeInstanceOf(Err);
  });

  it('replays a run with submit deterministically', async () => {
    const recordCalls: number[] = [];
    const recorded = await runParent({ calls: recordCalls });
    const replayCalls: number[] = [];
    const replayed = await runParent({ calls: replayCalls, journal: recorded.journal });
    expect(recordCalls).toEqual([2]);
    expect(replayCalls).toEqual([]);
    expect(replayed.receipts).toEqual(recorded.receipts);
    expect(Journal.dump(replayed.journal)).toBe(Journal.dump(recorded.journal));
    expect(resultFocus(replayed).from_child).toBe(4);
  });

  it('interrupts and resumes through a submit', async () => {
    const first: number[] = [];
    const partial = await runParent({ calls: first, maxEffects: 1 });
    expect(partial.suspended).toBe(true);
    expect(first).toEqual([]);

    const second: number[] = [];
    const resumed = await runParent({ calls: second, journal: partial.journal });
    expect(resumed.suspended).toBe(false);
    expect(second).toEqual([2]);
    expect(resultFocus(resumed).from_child).toBe(4);
  });

  it('does not corrupt lexical Kits when parallel branches submit', async () => {
    const parallel = submitter('double', 'a').par(submitter('triple', 'b'));
    let broken = 0;
    for (let index = 0; index < 200; index += 1) {
      const out = await Executor.run(parallel, {
        policy: allow(), seed: 1, registry: twoPorts([]), programs: twoPrograms(), kit: twoKit(),
      });
      const focus = out.result instanceof Ok ? out.result.focus.toObject() as Record<string, unknown> : {};
      if (focus.a !== 4 || focus.b !== 6) broken += 1;
    }
    expect(broken).toBe(0);
  });

  it('stores machine-readable grounds instead of inspect strings', async () => {
    const submit = (await runParent()).receipts.at(-1)?.grounds as {
      verdict: string;
      request: { tag: string; payload: { name: string } };
      grounds: { policy: string; detail: string }[];
    };
    expect(submit.verdict).toBe('admitted');
    expect(submit.request.tag).toBe(PROGRAM_SUBMIT_TAG);
    expect(submit.request.payload.name).toBe('double');
    expect(submit.grounds.map((ground) => ground.policy)).toEqual(['by_kit', 'allow_all']);
    expect(submit.grounds[0]?.detail).toMatch(/program double is handed down/u);
  });

  it('does not leak runtime inspect strings into the journal', async () => {
    const dump = Journal.dump((await runParent()).journal);
    expect(dump).not.toContain('[object Object]');
    expect(dump).not.toContain('class Kit');
    for (const line of dump.split('\n').filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('stores machine-readable denied grounds too', async () => {
    const out = await runParent({ kit: kit(0) });
    const denied = out.journal.toArray().find((entry) => entry.kind === 'admission_denied');
    expect(denied?.payload.tag).toBe(PROGRAM_SUBMIT_TAG);
    expect(denied?.payload.by).toBe('by_kit');
    expect(denied?.payload.reason).toMatch(/depth is exhausted/u);
  });

  it('returns ChildFailed as an ordinary Berylx Err when a child closes with Err', async () => {
    const failing = Task.of('failing', (_lay) => { throw new Error('child boom'); });
    const registry = new ProgramRegistry().register({
      name: 'failing', task: failing, input: ProbeIn, output: ProbeOut,
    });
    const out = await Executor.run(parent('failing'), {
      policy: allow(),
      seed: 1,
      registry: ports([]),
      programs: registry,
      kit: Kit.of({ ports: [PROGRAM_SUBMIT_TAG], programs: ['failing'], depth: 1 }),
    });
    expect(out.result).toBeInstanceOf(Err);
    if (!(out.result instanceof Err)) throw new Error('expected Err');
    expect(out.result.cause).toBeInstanceOf(ChildFailed);
  });

  it('returns an output BoundaryError as an ordinary Berylx Err', async () => {
    const invalidOutput = Task.of('invalid_output', (lay) => lay);
    const registry = new ProgramRegistry().register({
      name: 'invalid_output', task: invalidOutput, input: ProbeIn, output: ProbeOut,
    });
    const out = await Executor.run(parent('invalid_output'), {
      policy: allow(),
      seed: 1,
      registry: ports([]),
      programs: registry,
      kit: Kit.of({ ports: [PROGRAM_SUBMIT_TAG], programs: ['invalid_output'], depth: 1 }),
    });
    expect(out.result).toBeInstanceOf(Err);
    if (!(out.result instanceof Err)) throw new Error('expected Err');
    expect(out.result.cause).toBeInstanceOf(BoundaryError);
    expect(out.receipts.at(-1)?.succeeded).toBe(false);
  });

  it('rejects an async child selected by a sync submitter before the child or gate starts', async () => {
    let childStarted = false;
    const child = AsyncTask.of('async_child', async (lay) => {
      childStarted = true;
      return lay.put('doubled', 4);
    });
    const registry = new ProgramRegistry().register({
      name: 'async_child', task: child, input: ProbeIn, output: ProbeOut,
    });

    const out = await Executor.run(parent('async_child'), {
      policy: allow(),
      seed: 1,
      registry: ports([]),
      programs: registry,
      kit: Kit.of({ ports: [PROGRAM_SUBMIT_TAG], programs: ['async_child'], depth: 1 }),
    });

    expect(out.result).toBeInstanceOf(Err);
    expect(childStarted).toBe(false);
    expect(out.lastTick).toBe(0);
    expect(out.journal.toArray()).toEqual([]);
    expect(out.receipts).toEqual([]);
  });

  it('bounds submit depth at 32 even without a Kit', async () => {
    const recursive = Task.of('recursive', (lay, io) => {
      io.perform(PROGRAM_SUBMIT_TAG, { name: 'recursive', focus: { n: 1 } });
      return lay.put('doubled', 2);
    });
    const registry = new ProgramRegistry().register({
      name: 'recursive', task: recursive, input: ProbeIn, output: ProbeOut,
    });
    const out = await Executor.run(parent('recursive', 1), {
      policy: allow(), seed: 1, registry: ports([]), programs: registry,
    });
    expect(out.result).toBeInstanceOf(Err);
    expect(out.lastTick).toBe(33);
    const failures = out.journal.toArray().filter((entry) => entry.kind === 'effect_failed');
    expect(failures.some((entry) => entry.payload.error === TooDeep.name)).toBe(true);
  });
});

function twoPorts(calls: string[]): PortRegistry {
  const registry = new PortRegistry();
  for (const [name, factor] of [['probe2', 2], ['probe3', 3]] as const) {
    registry.register(new PortAdapter(name).operation(name, ProbeIn, ProbeOut, (payload) => {
      calls.push(name);
      return { n: payload.n, doubled: payload.n * factor };
    }));
  }
  return registry;
}

function effectfulChild(tag: string): Task {
  return Task.of(tag, (lay, io) => {
    const n = lay.at('n').fetch() as number;
    const output = io.perform(tag, { n }) as { doubled: number };
    return lay.put('doubled', output.doubled);
  });
}

function twoPrograms(): ProgramRegistry {
  return new ProgramRegistry()
    .register({ name: 'double', task: effectfulChild('probe2'), input: ProbeIn, output: ProbeOut })
    .register({ name: 'triple', task: effectfulChild('probe3'), input: ProbeIn, output: ProbeOut });
}

function submitter(name: string, key: string): Task {
  return Task.of(`submit_${name}`, (lay, io) => {
    const output = io.perform(PROGRAM_SUBMIT_TAG, { name, focus: { n: 2 } }) as {
      doubled: number;
    };
    return lay.put(key, output.doubled);
  });
}

function twoKit(): Kit {
  return Kit.of({
    ports: ['probe2', 'probe3', PROGRAM_SUBMIT_TAG],
    programs: ['double', 'triple'],
    depth: 1,
  });
}
