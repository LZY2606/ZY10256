/**
 * Deterministic PRNG (mulberry32) so every property test is reproducible
 * without any dependency on the real clock or Math.random().
 */
export type Rng = () => number;

export const createRng = (seed: number): Rng => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const pickInt = (rng: Rng, min: number, max: number): number => {
  return min + Math.floor(rng() * (max - min + 1));
};

export const pickOne = <T>(rng: Rng, items: readonly T[]): T => {
  return items[Math.floor(rng() * items.length)];
};
