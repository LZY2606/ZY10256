import assert from 'node:assert';
import type { DiffResult, DifferOptions } from '../../src/differ';
import type { DiffPair, Side } from './contract';
import type { JsonValue } from './generator';

/**
 * In-test patch interpreter.
 *
 * The differ's output is treated as a unified-style patch script:
 * - `equal` rows are shared context;
 * - `add` rows only exist on the right;
 * - `remove` rows only exist on the left;
 * - `modify` pairs carry the post-image on the right and the pre-image left.
 *
 * Interpreting the script together with each side's unchanged context must
 * rebuild a syntactically complete JSON document that deep-equals the original
 * input. If any change were dropped, duplicated or misaligned, JSON parsing
 * would fail or the deep equality would break.
 */

const INDENT_SPACES = 2;

const renderSideDocument = (lines: Side): string => lines
  .filter(line => line.text !== '')
  .map(line => {
    const indentation = ' '.repeat(line.level * INDENT_SPACES);
    return `${indentation}${line.text}${line.comma ? ',' : ''}`;
  })
  .join('\n');

const parseDocument = (text: string, sideName: string, ctx: { label: string }): JsonValue => {
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    throw new Error(
      `patch replay: reconstructed ${sideName} document is not valid JSON (${(error as Error).message})\n` +
      `case: ${ctx.label}\n--- reconstructed ${sideName} ---\n${text}`,
    );
  }
};

export interface ReplayResult {
  leftDocument: JsonValue;
  rightDocument: JsonValue;
  leftText: string;
  rightText: string;
}

export const replayPair = (pair: DiffPair, label: string): ReplayResult => {
  const leftText = renderSideDocument(pair[0]);
  const rightText = renderSideDocument(pair[1]);
  return {
    leftText,
    rightText,
    leftDocument: parseDocument(leftText, 'left', { label }),
    rightDocument: parseDocument(rightText, 'right', { label }),
  };
};

export const assertReplayDeepEquals = (
  pair: DiffPair,
  before: JsonValue,
  after: JsonValue,
  label: string,
): ReplayResult => {
  const replayed = replayPair(pair, label);
  try {
    assert.deepStrictEqual(replayed.leftDocument, before);
  } catch (error) {
    throw new Error(
      `patch replay loses or corrupts left data (${(error as Error).message.split('\n')[0]})\n` +
      `case: ${label}\n--- reconstructed left ---\n${replayed.leftText}\n--- expected before ---\n${JSON.stringify(before, null, 2)}`,
    );
  }
  try {
    assert.deepStrictEqual(replayed.rightDocument, after);
  } catch (error) {
    throw new Error(
      `patch replay loses or corrupts right data (${(error as Error).message.split('\n')[0]})\n` +
      `case: ${label}\n--- reconstructed right ---\n${replayed.rightText}\n--- expected after ---\n${JSON.stringify(after, null, 2)}`,
    );
  }
  return replayed;
};

/**
 * LCS table for the *original* scalar arrays. When `arrayDiffMethod: 'lcs'`
 * emits remove/add rows (modifications disabled so every change is a real edit
 * script step), their number must equal the Levenshtein-style minimum
 * `|A| + |B| - 2 * LCS(A, B)`. We deliberately do NOT assert which optimal
 * alignment is chosen: repeated values admit multiple equivalent LCS paths.
 */
export const lcsLength = (left: JsonValue[], right: JsonValue[]): number => {
  const table = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      table[i][j] = JSON.stringify(left[i - 1]) === JSON.stringify(right[j - 1])
        ? table[i - 1][j - 1] + 1
        : Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
  return table[left.length][right.length];
};

export const countScriptEdits = (pair: DiffPair): number => {
  let edits = 0;
  // A `modify` scalar row is a one-row rendering of one deletion plus one
  // insertion, so it counts as two edit operations.
  let modifications = 0;
  const countSide = (lines: DiffResult[], type: 'add' | 'remove') => {
    for (const line of lines) {
      // Only root-array scalar rows are counted by the minimal-edit test.
      if (line.level === 1 && line.text !== '' && line.type === type) {
        edits++;
      }
    }
  };
  for (const line of pair[0]) {
    if (line.level === 1 && line.text !== '' && line.type === 'modify') {
      modifications++;
    }
  }
  countSide(pair[0], 'remove');
  countSide(pair[1], 'add');
  return edits + modifications * 2;
};

export const MINIMAL_EDIT_OPTIONS: DifferOptions = {
  arrayDiffMethod: 'lcs',
  showModifications: false,
  preserveKeyOrder: 'before',
};
