/**
 * Deterministic PRNG (mulberry32) for the diff-model consistency suite.
 *
 * The whole point of these tests is reproducibility: a given seed must always
 * generate the same JSON value and the same sequence of mutations, on every
 * supported platform. Nothing here reads the clock, `Math.random()` or the
 * environment, so failures can be replayed and shrunk deterministically.
 */

export class Random {
  private state: number;

  constructor(seed: number) {
    // Make sure the state is an unsigned 32-bit integer.
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6D2B79F5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max] (both ends inclusive). */
  int(min: number, max: number): number {
    if (max < min) {
      throw new Error(`Random.int: empty range [${min}, ${max}]`);
    }
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (!items.length) {
      throw new Error('Random.pick: cannot pick from an empty list');
    }
    return items[this.int(0, items.length - 1)];
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** A fresh Random instance whose seed is a deterministic function of this one. */
  branch(salt: number): Random {
    return new Random((this.state ^ Math.imul(salt + 1, 0x9E3779B9)) >>> 0);
  }
}

export const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
