import { AsyncTask, Err, Task } from '@minamorl/berylx';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Admission,
  Executor,
  JournalEntry,
  JournalLog,
  Kit,
  MACHINE_ACCEPTED,
  Machine,
  MachineFeed,
  MachineIntake,
  MachineLedger,
  PROGRAM_SUBMIT_TAG,
  PortAdapter,
  PortRegistry,
  ProgramRegistry,
  ReplayMismatch,
  ReplayUnreadable,
} from '../src/index.js';

const Input = z.object({ n: z.number().int() }).describe('AuditIn');
const Output = z.object({ n: z.number().int(), doubled: z.number().int() }).describe('AuditOut');
const ParallelOutput = z.object({
  n: z.number().int(), a: z.number().int(), b: z.number().int(),
}).describe('AuditParOut');

const allow = () => new Admission.AllowAll();

function ports(calls: number[], factor = 2, raise?: (payload: { n: number }) => void): PortRegistry {
  const registry = new PortRegistry();
  for (const tag of ['probe', 'probe2']) {
    registry.register(new PortAdapter(tag).operation(tag, Input, Output, (payload) => {
      calls.push(payload.n);
      raise?.(payload);
      return { n: payload.n, doubled: payload.n * factor };
    }));
  }
  return registry;
}

function effectful(tag: string, key = 'doubled'): Task {
  return Task.of(tag, (lay, io) => {
    const n = lay.at('n').fetch() as number;
    const output = io.perform(tag, { n }) as { doubled: number };
    return lay.put(key, output.doubled);
  });
}

function doublePrograms(): ProgramRegistry {
  return new ProgramRegistry().register({
    name: 'double', task: effectful('probe'), input: Input, output: Output,
  });
}

describe('adversarial audit regressions', () => {
  it('A: does not deadlock on a parallel branch inside program_submit', async () => {
    const programs = new ProgramRegistry().register({
      name: 'par',
      task: effectful('probe', 'a').par(effectful('probe2', 'b')),
      input: Input,
      output: ParallelOutput,
    });
    const parent = Task.of('parent', (lay, io) =>
      lay.put('out', io.perform(PROGRAM_SUBMIT_TAG, { name: 'par', focus: { n: 2 } })),
    );
    const kit = Kit.of({
      ports: ['probe', 'probe2', PROGRAM_SUBMIT_TAG], programs: ['par'], depth: 1,
    });

    const outcome = await Executor.run(parent, {
      policy: allow(), seed: 1, registry: ports([]), programs, kit,
    });
    expect(outcome.journal.portResults()).toHaveLength(2);
  });

  it('H: bounds self-submission even without a Kit', async () => {
    const recursive = Task.of('loop_forever', (lay, io) => {
      io.perform(PROGRAM_SUBMIT_TAG, { name: 'loop_forever', focus: { n: 1 } });
      return lay;
    });
    const programs = new ProgramRegistry().register({
      name: 'loop_forever', task: recursive, input: Input, output: Input,
    });
    const outcome = await Executor.run(recursive, {
      policy: allow(), seed: 1, registry: ports([]), programs,
    });

    expect(outcome.result).toBeInstanceOf(Err);
    expect(outcome.receipts.length).toBeLessThanOrEqual(Executor.Driver.MAX_SUBMIT_DEPTH + 1);
  });

  it('B1: refuses replay when the same tag has a different payload', async () => {
    const recorded = await Executor.run(effectful('probe'), {
      policy: allow(), seed: 1, registry: ports([]), focus: { n: 2 },
    });
    expect(recorded.journal.portResults()).toHaveLength(1);

    await expect(Executor.run(effectful('probe'), {
      policy: allow(), seed: 1, registry: ports([]), focus: { n: 9 }, journal: recorded.journal,
    })).rejects.toBeInstanceOf(ReplayMismatch);
  });

  it('B2: raises instead of passing an unreadable replay value', async () => {
    const broken = new JournalLog().append(JournalEntry.at(1, 'port_result', {
      port: 'probe', request: { n: 2 }, result: { n: 'not an integer' },
    }));

    let raised: unknown;
    try {
      await Executor.run(effectful('probe'), {
        policy: allow(), seed: 1, registry: ports([]), focus: { n: 2 }, journal: broken,
      });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(ReplayUnreadable);
    expect((raised as ReplayUnreadable).tag).toBe('probe');
    expect((raised as ReplayUnreadable).violations.length).toBeGreaterThan(0);
    expect((raised as ReplayUnreadable).value).toEqual({ n: 'not an integer' });
  });

  it('E: records a receipt when an external handler fails', async () => {
    const calls: number[] = [];
    const outcome = await Executor.run(effectful('probe'), {
      policy: allow(),
      seed: 1,
      focus: { n: 2 },
      registry: ports(calls, 2, () => { throw new Error('ポートの向こうで壊れた'); }),
    });

    expect(calls).toEqual([2]);
    expect(outcome.result).toBeInstanceOf(Err);
    expect(outcome.receipts).toHaveLength(1);
    expect(outcome.receipts[0]?.succeeded).toBe(false);
    expect(outcome.journal.toArray().map((entry) => entry.kind)).toContain('effect_failed');
    expect(outcome.receipts[0]?.grounded).toBe(true);
  });

  it('C: does not replace a remembered journal with fewer port results', () => {
    const ledger = new MachineLedger();
    const long = new JournalLog()
      .append(JournalEntry.at(1, 'port_result', { port: 'probe' }))
      .append(JournalEntry.at(2, 'port_result', { port: 'probe' }));
    const short = new JournalLog().append(JournalEntry.at(1, 'port_result', { port: 'probe' }));

    ledger.remember(7, long);
    ledger.remember(7, short);
    expect(ledger.journalFor(7)?.portResults()).toHaveLength(2);
  });

  it('D: carries ticket space into a rebuilt Machine', async () => {
    const ledger = new MachineLedger();
    const handed = Kit.of({
      ports: ['probe', PROGRAM_SUBMIT_TAG], programs: ['double'], depth: 1,
    });
    const first = new Machine({ programs: doublePrograms(), ports: ports([]), ledger });
    const used = first.submit({ name: 'double', focus: { n: 2 }, kit: handed }).ticket;
    await first.step();

    const second = new Machine({
      programs: doublePrograms(), ports: ports([]), ledger, intake: new MachineIntake(),
    });
    const fresh = second.submit({ name: 'double', focus: { n: 9 }, kit: handed }).ticket;
    expect(fresh).not.toBe(used);
    expect(fresh).toBe(2);
  });

  it('F: isolates malformed feed lines and records valid ones through Machine.submit', async () => {
    const lines = [
      JSON.stringify({ name: 'double', focus: { n: 1 } }),
      JSON.stringify({ name: 'double', kit: 42 }),
      JSON.stringify(['top level is an array']),
      JSON.stringify({ name: 'double', focus: { n: 2 } }),
    ].join('\n');
    const runtime = new Machine({ programs: doublePrograms(), ports: ports([]) });
    const feed = new MachineFeed({ io: `${lines}\n`, machine: runtime });
    const accepted = await feed.absorb();

    expect(accepted).toHaveLength(2);
    expect(feed.rejected).toHaveLength(2);
    expect(runtime.ledger.ofKind(MACHINE_ACCEPTED)).toHaveLength(2);
    expect(runtime.ledger.ofKind(MACHINE_ACCEPTED).map((record) => record.payload.focus))
      .toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('G: joins a sibling branch before suspension escapes', async () => {
    const finished: string[] = [];
    const slow = AsyncTask.of('slow', async (lay) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      finished.push('slow');
      return lay;
    });
    const thrower = Task.of('thrower', () => { throw new Executor.Suspend(); });

    const outcome = await Executor.run(thrower.par(slow), {
      policy: allow(), seed: 1, registry: ports([]),
    });
    expect(outcome.suspended).toBe(true);
    expect(finished).toEqual(['slow']);
  });
});
