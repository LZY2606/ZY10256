import { checkDiffModel } from './diff-model';
import type { DiffModelCase } from './diff-model';
import { deepClone } from './json-fuzz';
import type { JsonValue } from './json-fuzz';

/**
 * Greedy shrinker: when a contract fails, minimize the left / right JSON and
 * the fold parameters while the failure persists, so the reported case is
 * small enough to debug by hand. Fully deterministic (no clock, no random).
 */

const isObject = (v: JsonValue): v is { [key: string]: JsonValue } => {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
};

/** Smaller variants of a JSON value, cheapest first. */
const jsonCandidates = (value: JsonValue): JsonValue[] => {
  const result: JsonValue[] = [];
  if (Array.isArray(value)) {
    result.push(null);
    for (let i = 0; i < value.length; i++) {
      const next = deepClone(value) as JsonValue[];
      next.splice(i, 1);
      result.push(next);
    }
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] === 'object' && value[i] !== null) {
        const next = deepClone(value) as JsonValue[];
        next[i] = null;
        result.push(next);
      }
    }
  } else if (isObject(value)) {
    result.push(null);
    for (const key of Object.keys(value)) {
      const next = deepClone(value) as Record<string, JsonValue>;
      delete next[key];
      result.push(next);
    }
    for (const key of Object.keys(value)) {
      if (typeof value[key] === 'object' && value[key] !== null) {
        const next = deepClone(value) as Record<string, JsonValue>;
        next[key] = null;
        result.push(next);
      }
    }
  } else if (value !== null) {
    result.push(null);
  }
  return result;
};

const caseCandidates = (testCase: DiffModelCase): DiffModelCase[] => {
  const result: DiffModelCase[] = [];
  for (const candidate of jsonCandidates(testCase.sourceLeft)) {
    result.push({ ...testCase, sourceLeft: candidate });
  }
  for (const candidate of jsonCandidates(testCase.sourceRight)) {
    result.push({ ...testCase, sourceRight: candidate });
  }
  if (testCase.fold.margin > 0) {
    result.push({ ...testCase, fold: { ...testCase.fold, margin: testCase.fold.margin - 1 } });
  }
  if (testCase.fold.threshold > 1) {
    result.push({ ...testCase, fold: { ...testCase.fold, threshold: testCase.fold.threshold - 1 } });
  }
  return result;
};

export const shrinkCase = (
  testCase: DiffModelCase,
  check: (testCase: DiffModelCase) => string | null = checkDiffModel,
): DiffModelCase => {
  let current = testCase;
  // Every accepted candidate strictly reduces the problem size, so this loop
  // always terminates.
  for (;;) {
    const next = caseCandidates(current).find(candidate => check(candidate) !== null);
    if (!next) {
      return current;
    }
    current = next;
  }
};

const formatCase = (testCase: DiffModelCase): string => [
  `  left:         ${JSON.stringify(testCase.sourceLeft)}`,
  `  right:        ${JSON.stringify(testCase.sourceRight)}`,
  `  differOptions: ${JSON.stringify(testCase.differOptions)}`,
  `  fold:         ${JSON.stringify(testCase.fold)}`,
].join('\n');

/** Assert every diff-model contract; on failure report a shrunk case. */
export const assertDiffModel = (testCase: DiffModelCase): void => {
  const violation = checkDiffModel(testCase);
  if (!violation) {
    return;
  }
  const shrunk = shrinkCase(testCase);
  const shrunkViolation = checkDiffModel(shrunk) ?? '<none>';
  throw new Error([
    'diff model contract violated:',
    `  ${violation}`,
    '',
    'shrunk failing case:',
    formatCase(shrunk),
    `  shrunk violation: ${shrunkViolation}`,
    '',
    'original case:',
    formatCase(testCase),
  ].join('\n'));
};
