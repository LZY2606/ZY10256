import type { DiffResult, DifferOptions } from '../../src/differ';
import getInlineDiff from '../../src/utils/get-inline-diff';
import type { InlineDiffResult, InlineDiffOptions } from '../../src/utils/get-inline-diff';
import getSegments from '../../src/utils/get-segments';
import type { HideUnchangedLinesOptions } from '../../src/viewer';
import type { SegmentItem, HiddenUnchangedLinesInfo } from '../../src/utils/get-segments';
import { isExpandLine } from '../../src/utils/segment-util';
import { assertAlignedStructure } from './paths';

/**
 * Structural invariants shared by *every* `Differ.diff()` result, expressed
 * against the diff model (arrays of DiffResult) rather than rendered DOM.
 *
 * Every assertion failure is augmented with the two rendered JSON columns and
 * the offending row, so a shrunken fuzz case is immediately debuggable.
 */

export type Side = DiffResult[];
export type DiffPair = readonly [Side, Side];

export interface CheckContext {
  label: string;
  before: unknown;
  after: unknown;
  options: DifferOptions;
}

export class ContractError extends Error {}

const renderColumn = (lines: DiffResult[]): string => lines.map((line, index) => {
  const number = line.lineNumber === undefined ? '  ' : String(line.lineNumber).padStart(2, ' ');
  const text = line.text === '' ? '·' : line.text;
  return `${String(index).padStart(3, ' ')} #${number} ${line.type.padEnd(7)} ${'  '.repeat(line.level)}${text}`;
}).join('\n');

export const describeContext = (ctx: CheckContext, detail: string): string => [
  detail,
  '',
  `case: ${ctx.label}`,
  `options: ${JSON.stringify(ctx.options)}`,
  `before: ${JSON.stringify(ctx.before)}`,
  `after:  ${JSON.stringify(ctx.after)}`,
].join('\n');

const fail = (ctx: CheckContext, detail: string, left?: Side, right?: Side): never => {
  const blocks = [describeContext(ctx, detail)];
  if (left && right) {
    blocks.push('', '--- left column ---', renderColumn(left), '', '--- right column ---', renderColumn(right));
  }
  throw new ContractError(blocks.join('\n'));
};

const types = new Set(['equal', 'add', 'remove', 'modify']);

/**
 * Invariants 1 & 2:
 * - the two columns have the same physical length (every row is a pair);
 * - each line carries a known type and a non-negative level;
 * - visible line numbers on each side are 1..N with no gap or duplicate;
 * - blank placeholder lines never carry a line number.
 */
export const checkLineNumbersAndShape = (pair: DiffPair, ctx: CheckContext) => {
  const [left, right] = pair;
  if (left.length !== right.length) {
    fail(ctx, `column length mismatch: left=${left.length} right=${right.length}`, left, right);
  }
  ([
    [left, 'left'],
    [right, 'right'],
  ] as [Side, string][]).forEach(([lines, sideName]) => {
    const visibleNumbers: number[] = [];
    lines.forEach((line, index) => {
      if (!types.has(line.type)) {
        fail(ctx, `${sideName} row ${index}: unknown type "${line.type}"`, left, right);
      }
      if (line.level < 0 || !Number.isInteger(line.level)) {
        fail(ctx, `${sideName} row ${index}: invalid level ${line.level}`, left, right);
      }
      if (line.text === '') {
        if (line.lineNumber !== undefined) {
          fail(ctx, `${sideName} row ${index}: blank placeholder carries a line number`, left, right);
        }
      } else {
        if (line.lineNumber === undefined) {
          fail(ctx, `${sideName} row ${index}: visible line is missing a line number`, left, right);
        }
        visibleNumbers.push(line.lineNumber!);
      }
    });
    const expected = visibleNumbers.map((_, index) => index + 1);
    if (visibleNumbers.some((value, index) => value !== expected[index])) {
      fail(ctx, `${sideName}: visible line numbers are not strictly 1..N: [${visibleNumbers.join(', ')}]`, left, right);
    }
  });
};

/**
 * Invariant 3: at every row where both sides render text ("common context"),
 * the independently derived structural paths must coincide, and a truly
 * unchanged row renders the same text on both sides.
 *
 * Object key order is governed solely by `preserveKeyOrder`: with no option the
 * keys are sorted (we re-derive that from the model); we never assume the
 * native property-enumeration order is the canonical one.
 */
const checkCommonContextPaths = (pair: DiffPair, ctx: CheckContext) => {
  try {
    assertAlignedStructure(pair[0], pair[1], ctx.label);
  } catch (error) {
    fail(ctx, (error as Error).message, pair[0], pair[1]);
  }
};

/**
 * Invariant 4 (inline segments): for every pair of `modify` lines the inline
 * segment lists
 * - live inside the rendered string (`0 <= start <= end <= length`);
 * - are sorted and pairwise disjoint;
 * - together with the implicit untyped gaps cover the whole string (no hole);
 * - describe the same common subsequence on both sides in the same order, so
 *   applying them as a patch round-trips: unchanged + left-removed = left text
 *   and unchanged + right-added = right text (no data lost).
 */
interface Interval {
  start: number;
  end: number;
  type?: 'add' | 'remove';
}

const checkIntervals = (segments: InlineDiffResult[], text: string, sideName: string, ctx: CheckContext, pair: DiffPair) => {
  if (text === '') {
    if (segments.length) {
      fail(ctx, `${sideName}: empty text carries inline segments`, pair[0], pair[1]);
    }
    return;
  }
  if (!segments.length) {
    // No inline highlight at all is the Viewer's "render as plain text" case
    // (happens for modify lines that render identical text under index
    // alignment); nothing can overlap or overflow then.
    return;
  }
  let cursor = 0;
  for (const segment of segments) {
    if (!Number.isInteger(segment.start) || !Number.isInteger(segment.end)) {
      fail(ctx, `${sideName}: inline segment has non-integer endpoints ${segment.start}..${segment.end}`, pair[0], pair[1]);
    }
    if (segment.start < cursor) {
      fail(ctx, `${sideName}: inline segments overlap or reorder at ${segment.start} (cursor ${cursor})`, pair[0], pair[1]);
    }
    if (segment.start > cursor) {
      fail(ctx, `${sideName}: inline segments leave a gap before ${segment.start} (cursor ${cursor})`, pair[0], pair[1]);
    }
    if (segment.end < segment.start) {
      fail(ctx, `${sideName}: inline segment has inverted endpoints ${segment.start} > ${segment.end}`, pair[0], pair[1]);
    }
    if (segment.end > text.length) {
      fail(ctx, `${sideName}: inline segment ${segment.start}..${segment.end} overflows text length ${text.length}`, pair[0], pair[1]);
    }
    cursor = segment.end;
  }
  if (segments[segments.length - 1].end !== text.length) {
    fail(ctx, `${sideName}: inline segments do not cover the end of the string`, pair[0], pair[1]);
  }
};

const checkOneInlinePair = (
  leftText: string,
  rightText: string,
  options: InlineDiffOptions,
  ctx: CheckContext,
  pair: DiffPair,
  inlineDiff: InlineDiffFunc,
) => {
  const [rawLeft, rawRight] = inlineDiff(leftText, rightText, options);
  checkIntervals(rawLeft, leftText, 'left inline', ctx, pair);
  checkIntervals(rawRight, rightText, 'right inline', ctx, pair);
  const leftSegments = rawLeft;
  const rightSegments = rawRight;

  // Untyped segments, in order, are the edit-script chunks; the sequence of
  // shared chunks must spell the same string on both sides.
  const rebuild = (segments: Interval[], text: string) => segments.map(segment => text.slice(segment.start, segment.end)).join('');
  const rebuiltLeft = rebuild(leftSegments, leftText);
  const rebuiltRight = rebuild(rightSegments, rightText);
  if (rebuiltLeft !== leftText) {
    fail(ctx, `inline patch drops/duplicates left characters: got ${JSON.stringify(rebuiltLeft)}`, pair[0], pair[1]);
  }
  if (rebuiltRight !== rightText) {
    fail(ctx, `inline patch drops/duplicates right characters: got ${JSON.stringify(rebuiltRight)}`, pair[0], pair[1]);
  }
  const sharedLeft = leftSegments.filter(segment => !segment.type).map(segment => leftText.slice(segment.start, segment.end)).join('');
  const sharedRight = rightSegments.filter(segment => !segment.type).map(segment => rightText.slice(segment.start, segment.end)).join('');
  if (sharedLeft !== sharedRight) {
    fail(
      ctx,
      `inline common subsequence diverges: ${JSON.stringify(sharedLeft)} vs ${JSON.stringify(sharedRight)}`,
      pair[0],
      pair[1],
    );
  }
  // The removed / added pieces are exactly what separates the two texts.
  const removedLength = leftSegments
    .filter(segment => segment.type === 'remove')
    .reduce((sum, segment) => sum + (segment.end - segment.start), 0);
  const addedLength = rightSegments
    .filter(segment => segment.type === 'add')
    .reduce((sum, segment) => sum + (segment.end - segment.start), 0);
  const sharedLeftLength = leftSegments
    .filter(segment => !segment.type)
    .reduce((sum, segment) => sum + (segment.end - segment.start), 0);
  const sharedRightLength = rightSegments
    .filter(segment => !segment.type)
    .reduce((sum, segment) => sum + (segment.end - segment.start), 0);
  if (removedLength + sharedLeftLength !== leftText.length || addedLength + sharedRightLength !== rightText.length) {
    fail(ctx, 'inline changed pieces do not partition their side together with the shared pieces', pair[0], pair[1]);
  }
};

export type InlineDiffFunc = typeof getInlineDiff;

export const checkInlineSegments = (
  pair: DiffPair,
  ctx: CheckContext,
  inlineModes: InlineDiffOptions[] = [
    { mode: 'char' },
    { mode: 'word', wordSeparator: ' ' },
  ],
  inlineDiff: InlineDiffFunc = getInlineDiff,
) => {
  const [left, right] = pair;
  for (const mode of inlineModes) {
    for (let index = 0; index < left.length; index++) {
      if (left[index].type === 'modify' && right[index].type === 'modify') {
        // Multi-line modify blocks are padded with blank rows on the shorter
        // side; the Viewer only has two strings to compare when both render.
        if (left[index].text === '' || right[index].text === '') {
          continue;
        }
        checkOneInlinePair(left[index].text, right[index].text, mode, { ...ctx, label: `${ctx.label} [inline ${mode.mode}]` }, pair, inlineDiff);
      }
    }
  }
};

/**
 * Invariant 5 (folded segments / placeholders): `getSegments` partitions the
 * aligned row range `[0, N)` into ordered, non-overlapping pieces where
 * - regular segments render exactly their `[start, end)` rows (half-open, the
 *   same convention the Viewer uses for layout heights);
 *   - "expand" placeholders mark one hidden run; replacing each placeholder by
 *     its `[start, end)` rows restores the complete, unchanged model — folding
 *     never loses data.
 */
export type AnySegment = SegmentItem | HiddenUnchangedLinesInfo;

const checkSegmentBounds = (segments: AnySegment[], length: number, ctx: CheckContext, pair: DiffPair) => {
  if (!segments.length) {
    fail(ctx, 'getSegments returned an empty partition', pair[0], pair[1]);
  }
  let cursor = 0;
  segments.forEach((segment, index) => {
    if (segment.start < cursor) {
      fail(ctx, `segment ${index} starts at ${segment.start}, before partition cursor ${cursor}`, pair[0], pair[1]);
    }
    if (segment.end < segment.start) {
      fail(ctx, `segment ${index} has inverted range ${segment.start}..${segment.end}`, pair[0], pair[1]);
    }
    if (segment.end > length) {
      fail(ctx, `segment ${index} ends at ${segment.end}, past model length ${length}`, pair[0], pair[1]);
    }
    cursor = segment.end;
  });
  if (cursor !== length) {
    fail(ctx, `segments cover [0, ${cursor}), expected [0, ${length}) — folded rows are lost`, pair[0], pair[1]);
  }
};

const hiddenRuns = (pair: DiffPair): Array<[number, number]> => {
  const [left, right] = pair;
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < left.length; i++) {
    const isEqual = left[i].type === 'equal' && right[i].type === 'equal' && left[i].text !== '';
    if (isEqual && start === -1) {
      start = i;
    } else if (!isEqual && start !== -1) {
      runs.push([start, i]);
      start = -1;
    }
  }
  if (start !== -1) {
    runs.push([start, left.length]);
  }
  return runs;
};

export const checkFoldSegments = (
  pair: DiffPair,
  ctx: CheckContext,
  options: HideUnchangedLinesOptions,
  expectedHiddenRuns = 0,
) => {
  const [left, right] = pair;
  const jsonsAreEqual = left.length === right.length
    && left.every(line => line.type === 'equal')
    && right.every(line => line.type === 'equal');
  if (jsonsAreEqual) {
    // The Viewer renders a single "no change" row for equal JSON; no fold math applies.
    return;
  }
  const segments = getSegments(left, right, options, false) as AnySegment[];
  checkSegmentBounds(segments, left.length, ctx, pair);

  // Placeholders hide only genuinely-equal runs, and every placeholder expands
  // back to exactly the rows it hides.
  const expandSegments = segments.filter((segment): segment is HiddenUnchangedLinesInfo => isExpandLine(segment));
  for (const segment of expandSegments) {
    for (let i = segment.start; i < segment.end; i++) {
      if (!(left[i].type === 'equal' && right[i].type === 'equal' && left[i].text !== '')) {
        fail(ctx, `placeholder ${segment.start}..${segment.end} hides a non-context row ${i}`, left, right);
      }
    }
  }

  const runs = hiddenRuns(pair);
  if (expectedHiddenRuns && expandSegments.length !== expectedHiddenRuns) {
    fail(
      ctx,
      `expected ${expectedHiddenRuns} fold placeholder(s), got ${expandSegments.length}; equal runs ${JSON.stringify(runs)}`,
      left,
      right,
    );
  }

  // Expansion must restore the unfolded model exactly (rows + ordering).
  const expandedRows: number[] = [];
  for (const segment of segments) {
    for (let i = segment.start; i < segment.end; i++) {
      expandedRows.push(i);
    }
  }
  const expectedRows = left.map((_, index) => index);
  if (expandedRows.length !== expectedRows.length || expandedRows.some((row, index) => row !== expectedRows[index])) {
    fail(ctx, 'expanding all placeholders does not restore the original row sequence', left, right);
  }
};

/** Validate that every expand placeholder in a supplied partition hides only equal rows. */
export const checkPlaceholderRows = (
  segments: AnySegment[],
  pair: DiffPair,
  ctx: CheckContext,
) => {
  const [left, right] = pair;
  for (const segment of segments) {
    if (!isExpandLine(segment)) {
      continue;
    }
    for (let i = segment.start; i < segment.end; i++) {
      if (!(left[i].type === 'equal' && right[i].type === 'equal' && left[i].text !== '')) {
        fail(ctx, `placeholder ${segment.start}..${segment.end} hides a non-context row ${i}`, left, right);
      }
    }
  }
};

/**
 * Full model check for one diff pair.
 */
export interface FullCheckOptions {
  inline?: boolean;
  inlineDiff?: InlineDiffFunc;
  fold?: HideUnchangedLinesOptions | false;
  expectedFolds?: number;
}

export const checkDiffContract = (
  pair: DiffPair,
  ctx: CheckContext,
  options: FullCheckOptions = { inline: true, fold: false },
) => {
  checkLineNumbersAndShape(pair, ctx);
  checkCommonContextPaths(pair, ctx);
  if (options.inline !== false) {
    checkInlineSegments(pair, ctx, undefined, options.inlineDiff);
  }
  if (options.fold) {
    checkFoldSegments(pair, ctx, options.fold, options.expectedFolds ?? 0);
  }
};
