import Differ from '../../src/differ';
import type { DifferOptions } from '../../src/differ';
import { JsonGenerator, mutatePair, type JsonValue } from './generator';
import { Random } from './rng';
import { checkDiffContract, describeContext, type DiffPair } from './contract';
import { assertReplayDeepEquals } from './patch';
import { shrinkPair } from './shrink';
import sortInnerArrays from '../../src/utils/sort-inner-arrays';

/**
 * Property-based, model-level consistency suite.
 *
 * For each fixed seed we generate one JSON value, apply a logged sequence of
 * paired mutations, and verify against several supported configurations that:
 * - left/right visible line numbers are each continuous;
 * - common context rows correspond to the same structural path;
 * - inline change segments cover both strings without overlap;
 * - folded placeholders expand back to the full model;
 * - replaying the diff script rebuilds both inputs with no data loss.
 */

interface Scenario {
  name: string;
  options: DifferOptions;
  fold: { threshold: number; margin: number } | false;
}

const scenarios: Scenario[] = [
  { name: 'normal / sorted keys', options: { arrayDiffMethod: 'normal' }, fold: { threshold: 9, margin: 2 } },
  { name: 'normal / order before', options: { arrayDiffMethod: 'normal', preserveKeyOrder: 'before' }, fold: { threshold: 12, margin: 3 } },
  { name: 'normal / order after', options: { arrayDiffMethod: 'normal', preserveKeyOrder: 'after' }, fold: { threshold: 8, margin: 1 } },
  { name: 'lcs / sorted keys', options: { arrayDiffMethod: 'lcs' }, fold: { threshold: 10, margin: 2 } },
  { name: 'lcs / recursive equal', options: { arrayDiffMethod: 'lcs', recursiveEqual: true }, fold: { threshold: 14, margin: 3 } },
  { name: 'normal / git-style', options: { arrayDiffMethod: 'normal', showModifications: false }, fold: false },
  {
    name: 'unorder-lcs',
    options: { arrayDiffMethod: 'unorder-lcs' },
    fold: false,
  },
];

const verifyCase = (before: JsonValue, after: JsonValue, scenario: Scenario, seed: number, actions: string[]) => {
  const label = `seed=${seed} actions=[${actions.join(',')}] scenario="${scenario.name}"`;
  let pair: DiffPair;
  try {
    pair = new Differ(scenario.options).diff(before, after) as unknown as DiffPair;
  } catch (error) {
    throw new Error(`${describeContext({
      label,
      before,
      after,
      options: scenario.options,
    }, `differ threw: ${(error as Error).message}`)}`);
  }

  checkDiffContract(pair, { label, before, after, options: scenario.options }, {
    inline: true,
    fold: scenario.fold,
  });

  // Replay the script. For unorder methods the documented preprocessing step
  // sorts inner arrays first; that is part of the configuration, not hidden
  // key-enumeration behavior, so replay against the normalized inputs.
  const expectedBefore = scenario.options.arrayDiffMethod?.startsWith('unorder-')
    ? sortInnerArrays(before, scenario.options) as JsonValue
    : before;
  const expectedAfter = scenario.options.arrayDiffMethod?.startsWith('unorder-')
    ? sortInnerArrays(after, scenario.options) as JsonValue
    : after;
  assertReplayDeepEquals(pair, expectedBefore, expectedAfter, label);
};

const SEEDS = Array.from({ length: 40 }, (_, index) => index + 1);

describe('diff-model property invariants (seeded)', () => {
  it.each(SEEDS)('seed %#: generated/mutated pair satisfies every scenario', seedValue => {
    const seed = seedValue as number;
    const generator = new JsonGenerator(seed, { maxDepth: 4, maxWidth: 7, containerChance: 0.7 });
    const before = generator.root(seed % 2 ? 'object' : 'array');
    const { after, actions } = mutatePair(before, new Random(seed * 7919 + 13), 3);

    for (const scenario of scenarios) {
      try {
        verifyCase(before, after, scenario, seed, actions);
      } catch (error) {
        // Reduce both inputs while the contract keeps failing, then report the
        // shrunken pair plus the full rendered columns.
        const shrunken = shrinkPair(before, after, (smallBefore, smallAfter) => {
          try {
            verifyCase(smallBefore, smallAfter, scenario, seed, actions);
            return false;
          } catch (shrinkError) {
            return shrinkError instanceof Error;
          }
        });
        let minimalFailure: Error | undefined;
        try {
          verifyCase(shrunken.before, shrunken.after, scenario, seed, actions);
        } catch (rethrow) {
          minimalFailure = rethrow as Error;
        }
        throw new Error(
          `${(error as Error).message}\n\n` +
          `shrunk after ${shrunken.shrinks} structural removals:\n` +
          `before(min): ${JSON.stringify(shrunken.before)}\n` +
          `after(min):  ${JSON.stringify(shrunken.after)}\n` +
          `minimal failure: ${minimalFailure?.message ?? '(did not reproduce)'}`,
        );
      }
    }
  });
});
