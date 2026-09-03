import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Entry, load as loadJournal } from './journal.js';
import { Receipt } from './receipt.js';

export type ShadowEffectKind = 'shell' | 'http' | 'db' | 'discord';

export interface ShadowEffect {
  readonly kind: ShadowEffectKind;
  readonly payload: unknown;
}

export interface ShadowGear {
  record(effect: ShadowEffect, result: unknown): Receipt;
  count(): number;
}

export interface ShadowGearOptions {
  readonly journalPath: string;
}

const RECEIPT_KIND = 'receipt';

function readEntries(journalPath: string): readonly Entry[] {
  if (!existsSync(journalPath)) return [];
  return loadJournal(readFileSync(journalPath, 'utf8')).toArray();
}

function receiptsIn(entries: readonly Entry[]): readonly Receipt[] {
  return entries
    .filter((entry) => entry.kind === RECEIPT_KIND)
    .map((entry) => Receipt.fromObject(entry.payload));
}

/**
 * Records results observed by an embedding host without admitting or executing effects.
 */
export function createShadowGear({ journalPath }: ShadowGearOptions): ShadowGear {
  if (journalPath.length === 0) throw new TypeError('journalPath must not be empty');

  return Object.freeze({
    record(effect: ShadowEffect, result: unknown): Receipt {
      const entries = readEntries(journalPath);
      const receipts = receiptsIn(entries);
      const predecessor = receipts.at(-1) ?? null;
      const tick = (entries.at(-1)?.tick ?? 0) + 1;
      if (!Number.isSafeInteger(tick)) {
        throw new RangeError('next journal tick must be a safe integer');
      }
      const receipt = Receipt.issue({
        effect,
        outcome: Receipt.ok(result),
        grounds: {
          mode: 'shadow',
          observed: true,
          admittedByGear: false,
          executedByGear: false,
        },
        tick,
        predecessor,
      });
      const entry = Entry.at(receipt.tick, RECEIPT_KIND, { ...receipt.toJSON() });
      mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
      appendFileSync(
        journalPath,
        `${JSON.stringify({ tick: entry.tick, kind: entry.kind, payload: entry.payload })}\n`,
        { mode: 0o600 },
      );
      return receipt;
    },

    count(): number {
      return receiptsIn(readEntries(journalPath)).length;
    },
  });
}
