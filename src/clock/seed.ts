export type RunSeed = number | bigint;

const MASK64 = 0xffff_ffff_ffff_ffffn;
const GOLDEN = 0x9e37_79b9_7f4a_7c15n;

function word(value: bigint): bigint {
  return value & MASK64;
}

/** splitmix64 finalizer. All arithmetic is deliberately limited to 64 bits. */
export function mix(value: bigint): bigint {
  let mixed = word(value);
  mixed = word((mixed ^ (mixed >> 30n)) * 0xbf58_476d_1ce4_e5b9n);
  mixed = word((mixed ^ (mixed >> 27n)) * 0x94d0_49bb_1331_11ebn);
  return word(mixed ^ (mixed >> 31n));
}

/** Deterministically derive a per-tick seed from the explicit run seed. */
export function deriveSeed(runSeed: RunSeed, index: number): bigint {
  const a = mix(word(BigInt(runSeed)) + GOLDEN);
  const b = mix(word(BigInt(index)) + GOLDEN + a);
  return mix(a ^ b);
}

export class TickRandom {
  readonly #seed: bigint;
  #offset = 0n;

  constructor(seed: bigint) {
    this.#seed = word(seed);
  }

  nextUint64(): bigint {
    const value = mix(this.#seed + this.#offset * GOLDEN);
    this.#offset += 1n;
    return value;
  }

  nextFloat(): number {
    return Number(this.nextUint64() >> 11n) / 0x20_0000_0000_0000;
  }

  nextInt(bound: number): number {
    if (!Number.isSafeInteger(bound) || bound <= 0) {
      throw new RangeError(`bound must be a positive safe integer: ${bound}`);
    }
    return Number(this.nextUint64() % BigInt(bound));
  }
}
