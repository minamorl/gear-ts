import { describe, expect, it } from 'vitest';
import { Clock, Tick } from '../src/index.js';

const draw = (tick: Tick, count = 8) => {
  const rng = tick.rng();
  return Array.from({ length: count }, () => rng.nextInt(1_000_000));
};
const drawFrom = (rng: ReturnType<Tick['rng']>, count = 8) =>
  Array.from({ length: count }, () => rng.nextInt(1_000_000));

describe('Clock', () => {
  it('advances monotonically without gaps', () => {
    const clock = new Clock(42);
    expect(Array.from({ length: 5 }, () => clock.advance().index)).toEqual([1, 2, 3, 4, 5]);
  });

  it('starts at the origin and current does not advance', () => {
    const clock = new Clock(1);
    expect(clock.current().index).toBe(0);
    expect(clock.current().index).toBe(0);
    expect(clock.advance().index).toBe(1);
  });

  it('totally orders ticks within one run', () => {
    const clock = new Clock(7);
    const ticks = [clock.advance(), clock.advance(), clock.advance()];
    expect(ticks[0]!.compare(ticks[1]!)).toBeLessThan(0);
    expect([ticks[2]!, ticks[0]!, ticks[1]!].sort((a, b) => a.compare(b))).toEqual(ticks);
  });

  it('does not order ticks across runs', () => {
    const left = new Clock(1).advance();
    const right = new Clock(2).advance();
    expect(() => left.compare(right)).toThrow(TypeError);
  });

  it('reproduces ticks and random values for the same seed', () => {
    const left = new Clock(12_345);
    const right = new Clock(12_345);
    for (let index = 0; index < 10; index += 1) {
      const a = left.advance();
      const b = right.advance();
      expect(a.equals(b)).toBe(true);
      expect(draw(a)).toEqual(draw(b));
    }
  });

  it('derives the same random sequence repeatedly from a tick', () => {
    const clock = new Clock(999);
    const tick = clock.advance();
    expect(draw(tick)).toEqual(draw(tick));
    expect(drawFrom(tick.rng())).toEqual(drawFrom(clock.rngFor(tick)));
  });

  it('changes randomness when the run seed changes', () => {
    expect(draw(new Clock(1).advance())).not.toEqual(draw(new Clock(2).advance()));
  });

  it('changes randomness between ticks', () => {
    const clock = new Clock(555);
    expect(draw(clock.advance())).not.toEqual(draw(clock.advance()));
  });

  it('requires an explicit integer seed', () => {
    expect(() => new Clock('x' as never)).toThrow(TypeError);
    expect(() => new Clock(null as never)).toThrow(TypeError);
    expect(() => new Clock(1.5)).toThrow(TypeError);
  });

  it('rejects foreign ticks in rngFor', () => {
    expect(() => new Clock(1).rngFor(new Clock(2).advance())).toThrow(TypeError);
  });

  it('has no rewind API', () => {
    const clock = new Clock(1) as unknown as Record<string, unknown>;
    expect(clock.rewind).toBeUndefined();
    expect(clock.reset).toBeUndefined();
    expect(clock.advanceTo).toBeUndefined();
  });

  it('freezes tick values', () => {
    expect(Object.isFrozen(new Clock(1).advance())).toBe(true);
  });
});
