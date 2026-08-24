import { deriveSeed, TickRandom, type RunSeed } from './seed.js';

export class Tick {
  readonly runSeed: RunSeed;
  readonly index: number;

  constructor(runSeed: RunSeed, index: number) {
    this.runSeed = runSeed;
    this.index = index;
    Object.freeze(this);
  }

  rng(): TickRandom {
    return new TickRandom(deriveSeed(this.runSeed, this.index));
  }

  compare(other: Tick): number {
    if (this.runSeed !== other.runSeed) {
      throw new TypeError('ticks from different runs are not ordered');
    }
    return this.index - other.index;
  }

  equals(other: unknown): other is Tick {
    return other instanceof Tick && this.runSeed === other.runSeed && this.index === other.index;
  }

  toString(): string {
    return `tick(run=${this.runSeed}, index=${this.index})`;
  }
}
