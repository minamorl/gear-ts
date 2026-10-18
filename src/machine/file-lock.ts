import { readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { JournalWriteError } from "../journal.js";

const waitCell = new Int32Array(new SharedArrayBuffer(4));
let nextOwner = 0;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Synchronous, narrow file section; no program or external effect runs while held. */
export function withFileLock<T>(path: string, operation: () => T): T {
  const lock = `${path}.lock`;
  const owner = `${process.pid}:${++nextOwner}`;
  let acquired = false;
  for (let attempt = 0; attempt <= 5; attempt += 1) {
    try {
      symlinkSync(owner, lock);
      acquired = true;
      break;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw new JournalWriteError("Shared state lock could not be acquired");
      }
      if (attempt === 5) break;
      const delay = 3 * 2 ** attempt + ((process.pid + attempt) % 3);
      Atomics.wait(waitCell, 0, 0, delay);
    }
  }
  if (!acquired) throw new JournalWriteError("Shared state is busy");
  try {
    return operation();
  } finally {
    let observed: string;
    try {
      observed = readlinkSync(lock);
    } catch {
      throw new JournalWriteError("Shared state lock was lost");
    }
    if (observed !== owner) {
      throw new JournalWriteError("Shared state lock changed ownership");
    }
    try {
      unlinkSync(lock);
    } catch {
      throw new JournalWriteError("Shared state lock could not be released");
    }
  }
}
