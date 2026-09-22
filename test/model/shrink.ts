import { cloneJson } from './rng';
import type { JsonValue } from './generator';

/**
 * Deterministic, structural shrinking for failed fuzz cases.
 *
 * On failure the spec prints both rendered columns AND the smallest input the
 * checker still rejects. Shrinking is order-independent (containers are
 * iterated by sorted keys for objects and by index for arrays), and it never
 * consults the clock or the file system.
 */

const objectKeysSorted = (value: JsonValue): string[] => {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value).sort();
  }
  return [];
};

const isContainer = (value: JsonValue): boolean =>
  Array.isArray(value) || (value !== null && typeof value === 'object');

/** Produce structurally smaller copies of `value` (empty containers and leaves are terminal). */
const shrinkCandidates = (value: JsonValue): JsonValue[] => {
  const candidates: JsonValue[] = [];
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const next = cloneJson(value);
      next.splice(i, 1);
      candidates.push(next);
    }
  } else if (value !== null && typeof value === 'object') {
    for (const key of objectKeysSorted(value)) {
      const next = cloneJson(value) as Record<string, JsonValue>;
      delete next[key];
      candidates.push(next);
    }
  }
  return candidates;
};

export interface ShrinkResult {
  before: JsonValue;
  after: JsonValue;
  shrinks: number;
}

/**
 * Greedy delta-debugging: independently shrink `before` and `after` while the
 * predicate keeps failing and the pair keeps changing. Containers nested in
 * both sides are reached because each top-level shrink exposes smaller
 * structures on later passes.
 */
export const shrinkPair = (
  before: JsonValue,
  after: JsonValue,
  fails: (before: JsonValue, after: JsonValue) => boolean,
  maxShrinks = 200,
): ShrinkResult => {
  let currentBefore = cloneJson(before);
  let currentAfter = cloneJson(after);
  let shrinks = 0;

  if (!fails(currentBefore, currentAfter)) {
    throw new Error('shrinkPair: predicate does not fail on the original case');
  }

  let changed = true;
  while (changed && shrinks < maxShrinks) {
    changed = false;

    // Shrink the "before" side (skip if it is a root scalar/empty container).
    if (isContainer(currentBefore)) {
      for (const candidate of shrinkCandidates(currentBefore)) {
        if (fails(candidate, currentAfter)) {
          currentBefore = candidate;
          changed = true;
          shrinks++;
          break;
        }
      }
    }
    if (changed) {
      continue;
    }

    if (isContainer(currentAfter)) {
      for (const candidate of shrinkCandidates(currentAfter)) {
        if (fails(currentBefore, candidate)) {
          currentAfter = candidate;
          changed = true;
          shrinks++;
          break;
        }
      }
    }
  }

  return { before: currentBefore, after: currentAfter, shrinks };
};
