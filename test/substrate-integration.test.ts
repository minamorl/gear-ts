import * as Berylx from '@minamorl/berylx';
import { Darkcore, EffectTree, Ok, Task } from '@minamorl/berylx';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Admission,
  Executor,
  Journal,
  Port,
  PortAdapter,
  PortRegistry,
  VERSION,
} from '../src/index.js';

const ProbePayload = z.object({ n: z.number().int() });
const ProbeResult = z.object({ n: z.number().int(), stdout: z.string() });

const allow = () => new Admission.AllowAll();

function probeAdapter(calls: number[], invalidResult = false): PortAdapter {
  return new PortAdapter('substrate_probe').operation(
    'substrate_probe',
    ProbePayload,
    ProbeResult,
    (payload) => {
      calls.push(payload.n);
      if (invalidResult) return { n: 'not-an-integer', stdout: 12 } as never;
      return { n: payload.n, stdout: `probe-${payload.n}` };
    },
  );
}

function registryWith(adapter: PortAdapter): PortRegistry {
  const registry = new PortRegistry();
  registry.register(adapter);
  return registry;
}

function probeTask(name: string, key: string, number: number): Task {
  return Task.of(name, (lay, io) => {
    const result = io.perform('substrate_probe', { n: number }) as { stdout: string };
    return lay.put(key, result.stdout);
  });
}

function twoProbes() {
  return probeTask('first_probe', 'first', 1).then(probeTask('second_probe', 'second', 2));
}

describe('substrate integration', () => {
  it('builds a Darkcore Effect tree from a Berylx Task', () => {
    const tree = EffectTree.build(probeTask('inspect_tree', 'value', 1), {});
    expect(tree).toBeInstanceOf(Darkcore.Effect);
    expect(tree.tag).toBe(EffectTree.TASK);
    expect(Object.getPrototypeOf(tree)).not.toBe(Object.prototype);
  });

  it('exposes the pending Effect/fold boundary without running the adapter early', () => {
    const calls: number[] = [];
    const adapter = probeAdapter(calls);
    const tree = EffectTree.build(probeTask('pending_probe', 'value', 7), {});

    expect(tree).toBeInstanceOf(Darkcore.Effect);
    expect(tree.tag).toBe(EffectTree.TASK);
    expect(calls).toEqual([]);
    const result = Darkcore.fold(
      tree,
      (value) => value,
      EffectTree.realHandlers(adapter.realHandlers() as Darkcore.HandlerMap),
    );
    expect(result).toBeInstanceOf(Ok);
    expect(calls).toEqual([7]);
  });

  it('uses one Darkcore Effect with a plain JSON port payload', () => {
    const effect = probeAdapter([]).effect('substrate_probe', { n: 3 });
    expect(effect).toBeInstanceOf(Darkcore.Effect);
    expect(effect.tag).toBe('substrate_probe');
    expect(effect.payload).toEqual({ n: 3 });
    expect(JSON.parse(JSON.stringify(effect.payload))).toEqual(effect.payload);
    expect(containsRuntimeObject(effect.payload)).toBe(false);
  });

  it('guards both Zod boundaries and delivers the typed result', async () => {
    const calls: number[] = [];
    const adapter = probeAdapter(calls);
    expect(() => adapter.effect('substrate_probe', { n: 'three' })).toThrow(Port.InvalidPayload);

    const invalid = probeAdapter([], true);
    expect(() => invalid.realHandlers().substrate_probe?.({ n: 3 })).toThrow(Port.InvalidResult);

    const out = await Executor.run(probeTask('typed_result', 'value', 3), {
      policy: allow(), seed: 11, registry: registryWith(adapter),
    });
    expect(out.result).toBeInstanceOf(Ok);
    if (!(out.result instanceof Ok)) throw new Error('expected Ok');
    expect((out.result.focus.toObject() as Record<string, unknown>).value).toBe('probe-3');
    expect(calls).toEqual([3]);
  });

  it('runs Darkcore, Berylx, and Gear end-to-end and replays identically', async () => {
    const recordCalls: number[] = [];
    const recorded = await Executor.run(twoProbes(), {
      policy: allow(), seed: 42, registry: registryWith(probeAdapter(recordCalls)),
    });
    const replayCalls: number[] = [];
    const replayed = await Executor.run(twoProbes(), {
      policy: allow(), seed: 42, registry: registryWith(probeAdapter(replayCalls)), journal: recorded.journal,
    });
    expect(recorded.result).toBeInstanceOf(Ok);
    expect(replayed.result).toBeInstanceOf(Ok);
    expect(recordCalls).toEqual([1, 2]);
    expect(replayCalls).toEqual([]);
    expect(recorded.journal.portResults()).toHaveLength(2);
    expect(recorded.journal.toArray().filter((entry) => entry.kind === 'receipt')).toHaveLength(2);
    expect(replayed.receipts).toEqual(recorded.receipts);
    expect(Journal.dump(replayed.journal)).toBe(Journal.dump(recorded.journal));
  });

  it('makes all substrate versions available', () => {
    const darkcoreVersion = Berylx.VERSION; // Darkcore is embedded in the Berylx package.
    const zodVersion = `${z.core.version.major}.${z.core.version.minor}.${z.core.version.patch}`;
    for (const version of [darkcoreVersion, Berylx.VERSION, zodVersion, VERSION]) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/u);
    }
  });
});

function containsRuntimeObject(value: unknown): boolean {
  if (typeof value === 'function') return true;
  if (Array.isArray(value)) return value.some(containsRuntimeObject);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([key, item]) => containsRuntimeObject(key) || containsRuntimeObject(item));
  }
  return false;
}
