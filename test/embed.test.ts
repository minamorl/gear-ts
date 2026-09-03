import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShadowGear } from '../src/embed.js';
import { Journal, Receipt } from '../src/index.js';

const directories: string[] = [];

function journalPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gear-shadow-'));
  directories.push(directory);
  return join(directory, 'journal.ndjson');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('createShadowGear', () => {
  it('journals an observed result without admitting or executing the effect', () => {
    const path = journalPath();
    const gear = createShadowGear({ journalPath: path });
    const payload = { command: 'printf shadow' };
    const execute = vi.fn(() => ({ stdout: 'should not run' }));

    const receipt = gear.record({ kind: 'shell', payload }, { stdout: 'observed' });

    expect(execute).not.toHaveBeenCalled();
    expect(receipt).toBeInstanceOf(Receipt);
    expect(receipt.effect).toEqual({ kind: 'shell', payload });
    expect(receipt.outcome).toEqual({ status: 'ok', value: { stdout: 'observed' } });
    expect(receipt.grounds).toEqual({
      mode: 'shadow',
      observed: true,
      admittedByGear: false,
      executedByGear: false,
    });
  });

  it('appends receipt NDJSON, chains receipts, and folds count from the journal', () => {
    const path = journalPath();
    const gear = createShadowGear({ journalPath: path });
    const first = gear.record({ kind: 'http', payload: { url: '/one' } }, { status: 200 });
    const second = gear.record({ kind: 'db', payload: { query: 'select 1' } }, [{ one: 1 }]);

    expect(first.predecessor).toBeNull();
    expect(second.predecessor).toBe(first.id);
    expect(gear.count()).toBe(2);

    const text = readFileSync(path, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const log = Journal.load(text);
    expect(log.toArray().map((entry) => entry.kind)).toEqual(['receipt', 'receipt']);
    expect(log.toArray()[1]?.payload).toEqual(second.toJSON());
    expect(createShadowGear({ journalPath: path }).count()).toBe(2);
  });

  it('advances the total journal tick after a mixed non-receipt entry', () => {
    const path = journalPath();
    writeFileSync(path, Journal.dump(new Journal.Log([
      Journal.Entry.at(7, Journal.PORT_RESULT, {
        port: 'http',
        request: { url: '/before-shadow' },
        result: { status: 200 },
      }),
    ])));

    const gear = createShadowGear({ journalPath: path });
    const receipt = gear.record(
      { kind: 'discord', payload: { channel: 'audit' } },
      { messageId: 'observed' },
    );

    expect(receipt.tick).toBe(8);
    expect(gear.count()).toBe(1);
    expect(Journal.load(readFileSync(path, 'utf8')).toArray().map((entry) => entry.tick))
      .toEqual([7, 8]);
  });

  it.each(['shell', 'http', 'db', 'discord'] as const)('accepts the %s shadow kind', (kind) => {
    const gear = createShadowGear({ journalPath: journalPath() });
    expect(gear.record({ kind, payload: null }, null).effect.kind).toBe(kind);
  });
});
