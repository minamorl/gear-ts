import { describe, expect, it } from 'vitest';
import {
  JournalEntry,
  JournalLog,
  MACHINE_ACCEPTED,
  MACHINE_COMPLETED,
  MACHINE_DENIED,
  MACHINE_SUSPENDED,
  MachineLedger,
} from '../../src/index.js';

describe('Machine.Ledger', () => {
  it('appends in order and keeps every record', () => {
    const ledger = new MachineLedger();
    ledger.append({ ticket: 1, kind: MACHINE_ACCEPTED });
    ledger.append({ ticket: 2, kind: MACHINE_DENIED, payload: { reason: '渡されていない' } });
    ledger.append({ ticket: 1, kind: MACHINE_COMPLETED, payload: { receipts: 2 } });

    expect(ledger.size).toBe(3);
    expect(ledger.toArray().map((record) => record.kind))
      .toEqual([MACHINE_ACCEPTED, MACHINE_DENIED, MACHINE_COMPLETED]);
  });

  it('queries records by ticket and by kind', () => {
    const ledger = new MachineLedger();
    ledger.append({ ticket: 1, kind: MACHINE_ACCEPTED });
    ledger.append({ ticket: 2, kind: MACHINE_ACCEPTED });
    ledger.append({ ticket: 1, kind: MACHINE_COMPLETED });

    expect(ledger.forTicket(1).map((record) => record.kind))
      .toEqual([MACHINE_ACCEPTED, MACHINE_COMPLETED]);
    expect(ledger.ofKind(MACHINE_ACCEPTED).map((record) => record.ticket)).toEqual([1, 2]);
  });

  it('reports the latest kind as ticket state', () => {
    const ledger = new MachineLedger();
    ledger.append({ ticket: 1, kind: MACHINE_ACCEPTED });
    expect(ledger.stateOf(1)).toBe(MACHINE_ACCEPTED);
    ledger.append({ ticket: 1, kind: MACHINE_SUSPENDED });
    expect(ledger.stateOf(1)).toBe(MACHINE_SUSPENDED);
    expect(ledger.stateOf(99)).toBeUndefined();
  });

  it('remembers the run journal as an index to the truth', () => {
    const ledger = new MachineLedger();
    const journal = new JournalLog().append(JournalEntry.at(1, 'receipt', {}));
    ledger.remember(3, journal);

    expect(ledger.journalFor(3)).toBe(journal);
    expect(ledger.journalFor(4)).toBeUndefined();
    expect([...ledger.journals.keys()]).toEqual([3]);
  });

  it('never trades recorded external results for same-length non-port entries', () => {
    const ledger = new MachineLedger();
    const recorded = new JournalLog()
      .append(JournalEntry.at(1, 'port_result', { port: 'probe' }))
      .append(JournalEntry.at(1, 'receipt', {}));
    const missingResult = new JournalLog()
      .append(JournalEntry.at(1, 'receipt', {}))
      .append(JournalEntry.at(2, 'receipt', {}));

    ledger.remember(3, recorded);
    ledger.remember(3, missingResult);

    expect(ledger.journalFor(3)).toBe(recorded);
  });

  it('preserves denial payloads', () => {
    const ledger = new MachineLedger();
    ledger.append({ ticket: 5, kind: MACHINE_DENIED, payload: { reason: '深さが尽きている' } });
    expect(ledger.forTicket(5)[0]?.payload.reason).toBe('深さが尽きている');
  });

  it('detaches and deeply freezes record payloads', () => {
    const ledger = new MachineLedger();
    const source = { nested: { values: [1, 2] } };
    const record = ledger.append({ ticket: 1, kind: MACHINE_ACCEPTED, payload: source });
    source.nested.values[0] = 99;

    expect(record.payload).toEqual({ nested: { values: [1, 2] } });
    expect(Object.isFrozen(record.payload.nested)).toBe(true);
  });
});
