import { Random } from './rng';
import { JsonGenerator, mutatePair, applyMutation, ALL_MUTATIONS } from './generator';

/**
 * Unit coverage for the seeded generator and paired mutators. These tests pin
 * determinism and the mutation vocabulary itself, so a future change to the
 * fuzz harness cannot silently stop exercising object/array/scalar edits.
 */

describe('seeded generator', () => {
  it('is deterministic for a fixed seed', () => {
    const first = new JsonGenerator(12345).root('any');
    const second = new JsonGenerator(12345).root('any');
    expect(second).toEqual(first);
  });

  it('produces JSON-round-trippable values', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const value = new JsonGenerator(seed, { maxDepth: 5, maxWidth: 8 }).root('any');
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
  });

  it('honors forced root shapes', () => {
    expect(Array.isArray(new JsonGenerator(1).root('array'))).toBe(true);
    expect(Array.isArray(new JsonGenerator(2).root('object'))).toBe(false);
    const object = new JsonGenerator(2).root('object');
    expect(object).not.toBeNull();
    expect(typeof object).toBe('object');
  });
});

describe('paired mutators', () => {
  it('every named mutation can be realized on a rich enough value', () => {
    const random = new Random(777);
    const before = new JsonGenerator(777, {
      maxDepth: 4,
      maxWidth: 8,
      containerChance: 0.9,
      longStringChance: 1,
    }).root('object');
    const realized = new Set<string>();
    for (let attempt = 0; attempt < 400 && realized.size < ALL_MUTATIONS.length; attempt++) {
      for (const name of ALL_MUTATIONS) {
        const result = applyMutation(before, name, new Random(attempt + 1));
        if (result) {
          realized.add(name);
        }
      }
    }
    expect([...realized].sort()).toEqual([...ALL_MUTATIONS].sort());
  });

  it('produces a changed, JSON-round-trippable pair', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const before = new JsonGenerator(seed, { containerChance: 0.8, longStringChance: 0.5 }).root('any');
      const { after, actions } = mutatePair(before, new Random(seed * 31 + 1), 4);
      expect(actions.length).toBeGreaterThan(0);
      expect(JSON.parse(JSON.stringify(after))).toEqual(after);
      expect(after).not.toEqual(before);
    }
  });

  it('a single-character mutation changes exactly one character', () => {
    const before: any = { long: 'abcdefghijklmnopqrstuvwxyz0123456789' };
    const random = new Random(1);
    // Drive attempts until the long-string mutator fires.
    let hit = false;
    for (let i = 1; i < 200 && !hit; i++) {
      const result = applyMutation(before, 'long-string-one-char', new Random(i));
      if (result && result.path.join('.') === 'long') {
        const after = result.after as { long: string };
        expect(after.long).toHaveLength(before.long.length);
        let diffs = 0;
        for (let j = 0; j < before.long.length; j++) {
          if (after.long[j] !== before.long[j]) {
            diffs++;
          }
        }
        expect(diffs).toBe(1);
        hit = true;
      }
    }
    expect(hit).toBe(true);
  });
});

describe('RNG', () => {
  it('replays identical integer sequences per seed', () => {
    const a = new Random(42);
    const b = new Random(42);
    for (let i = 0; i < 50; i++) {
      expect(a.int(-100, 100)).toBe(b.int(-100, 100));
    }
  });

  it('stays inside the requested range', () => {
    const random = new Random(9);
    for (let i = 0; i < 100; i++) {
      const value = random.int(3, 7);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(7);
    }
  });
});
