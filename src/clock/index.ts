import { z } from 'zod';
import { Tick } from './tick.js';
import type { RunSeed } from './seed.js';

export { deriveSeed, mix, TickRandom, type RunSeed } from './seed.js';
export { Tick } from './tick.js';

export const CLOCK_RANDOM_TAG = 'clock_random' as const;
export const ClockRandomPayload = z.object({ bound: z.number().int() });
export const ClockRandomResult = z.object({ value: z.number().int() });

export class Clock {
  static readonly ORIGIN_INDEX = 0;

  readonly seed: RunSeed;
  #index = Clock.ORIGIN_INDEX;

  constructor(seed: RunSeed) {
    if (
      (typeof seed !== 'number' || !Number.isSafeInteger(seed)) &&
      typeof seed !== 'bigint'
    ) {
      throw new TypeError(`seed must be an explicit integer: ${String(seed)}`);
    }
    this.seed = seed;
  }

  current(): Tick {
    return new Tick(this.seed, this.#index);
  }

  advance(): Tick {
    this.#index += 1;
    return this.current();
  }

  tick(): Tick {
    return this.advance();
  }

  rngFor(tick: Tick) {
    if (!(tick instanceof Tick) || tick.runSeed !== this.seed) {
      throw new TypeError(`tick does not belong to run seed ${this.seed}`);
    }
    return tick.rng();
  }
}
