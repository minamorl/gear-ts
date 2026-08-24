import { Task } from '@minamorl/berylx';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Journal,
  JournalEntry,
  JournalLog,
  Kit,
  MACHINE_ACCEPTED,
  Machine,
  PROGRAM_SUBMIT_TAG,
  PortAdapter,
  PortRegistry,
  ProgramRegistry,
  View,
} from '../src/index.js';

const InputSchema = z.object({ n: z.number().int() }).describe('ViewIn');
const OutputSchema = z.object({ n: z.number().int(), doubled: z.number().int() }).describe('ViewOut');

function ports(): PortRegistry {
  const registry = new PortRegistry();
  registry.register(new PortAdapter('probe').operation('probe', InputSchema, OutputSchema, (payload) => ({
    n: payload.n,
    doubled: payload.n * 2,
  })));
  return registry;
}

function programs(): ProgramRegistry {
  const task = Task.of('double', (lay, io) => {
    const n = lay.at('n').fetch() as number;
    const result = io.perform('probe', { n }) as { doubled: number };
    return lay.put('doubled', result.doubled);
  });
  return new ProgramRegistry().register({
    name: 'double',
    task,
    input: InputSchema,
    output: OutputSchema,
  });
}

function kit(allowed: readonly string[] = ['double']): Kit {
  return Kit.of({ ports: ['probe', PROGRAM_SUBMIT_TAG], programs: allowed, depth: 1 });
}

function machine(): Machine {
  return new Machine({ programs: programs(), ports: ports() });
}

async function ranJournal(allowed: readonly string[] = ['double']): Promise<Journal.Log> {
  const runtime = machine();
  runtime.submit({ name: 'double', focus: { n: 2 }, kit: kit(allowed) });
  const completion = await runtime.step();
  if (completion === undefined) throw new Error('expected completion');
  return completion.outcome.journal;
}

describe('View (Ruby view_test.rb 7-test parity)', () => {
  it('projects exact effect, denial, and receipt fields from a fresh journal fold', async () => {
    const journal = await ranJournal();
    const projection = View.project(journal);
    const receiptEntries = journal.toArray().filter((entry) => entry.kind === 'receipt');

    expect(projection.lastTick).toBe(2);
    expect(projection.effects).toEqual([{ tick: 2, port: 'probe' }]);
    expect(Object.keys(projection.effects[0]!)).toEqual(['tick', 'port']);
    expect(projection.denials).toEqual([]);
    expect(projection.receipts).toEqual(receiptEntries.map((entry) => {
      const effect = entry.payload.effect as Record<string, unknown>;
      return {
        tick: entry.tick,
        id: entry.payload.id,
        tag: effect.tag,
        predecessor: entry.payload.predecessor,
      };
    }));
    expect(Object.keys(projection.receipts[0]!)).toEqual(['tick', 'id', 'tag', 'predecessor']);
    expect(projection.quiet).toBe(false);
  });

  it('reports an empty journal as quiet', () => {
    expect(View.project(new JournalLog()).quiet).toBe(true);
  });

  it('holds no projection state of its own', async () => {
    const journal = await ranJournal();
    const renderer = new View.Text();

    expect(renderer.render(journal)).toBe(renderer.render(journal));
  });

  it('supports many renderers on one journal with exact text and plain summary data', async () => {
    const journal = await ranJournal();
    const text = new View.Text().render(journal);
    const summary = new View.Summary().render(journal);

    expect(text).toMatch(/^tick 2 \/ 効果 1 \/ 拒否 0 \/ receipt 2\n  2 probe$/u);
    expect(text.endsWith('\n')).toBe(false);
    expect(Object.getPrototypeOf(summary)).toBe(Object.prototype);
    expect(summary.last_tick).toBe(2);
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it('makes the picture grow with the journal and takes max tick from every entry', () => {
    const renderer = new View.Summary();
    const short = new JournalLog();
    const long = short
      .append(JournalEntry.at(5, 'unrelated', {}))
      .append(JournalEntry.at(2, Journal.PORT_RESULT, { port: 'probe' }));

    expect(renderer.render(short).last_tick).toBe(0);
    expect(renderer.render(long).last_tick).toBe(5);
    expect(View.project(new JournalLog([JournalEntry.at(7, 'unrelated', {})])).quiet).toBe(true);
  });

  it('draws denials with exact fields and Japanese detail', async () => {
    const journal = await ranJournal(['other']);
    const projection = View.project(journal);
    const text = new View.Text().render(journal);

    expect(projection.denials).toHaveLength(1);
    expect(Object.keys(projection.denials[0]!)).toEqual(['tick', 'tag', 'reason']);
    expect(text).toBe('tick 1 / 効果 0 / 拒否 1 / receipt 0\n' +
      '  1 拒否 program_submit — program double は渡されていない');
  });

  it('enters input as a program and changes no view state', () => {
    const runtime = machine();
    const input = new View.Input(runtime);
    const submission = input.request({ name: 'double', focus: { n: 2 }, kit: kit() });

    expect(runtime.pending).toBe(1);
    expect(runtime.stateOf(submission.ticket)).toBe(MACHINE_ACCEPTED);
    expect(View.project(new JournalLog()).quiet).toBe(true);
  });
});
