import Differ from '../../src/differ';
import getInlineDiff from '../../src/utils/get-inline-diff';
import getSegments from '../../src/utils/get-segments';
import { isExpandLine } from '../../src/utils/segment-util';
import { checkLineNumbersAndShape, checkFoldSegments, checkInlineSegments, checkPlaceholderRows, ContractError } from './contract';
import type { CheckContext, DiffPair } from './contract';
import type { InlineDiffResult } from '../../src/utils/get-inline-diff';
import { buildLongContextFactory } from './negative-fixtures';

/**
 * Negative tests prove the model contracts are enforceable: each case
 * deliberately breaks one invariant (right-side line numbers, placeholder
 * coverage, inline segment endpoints) and expects the checker to reject it
 * with a readable, row-scoped message.
 */

const ctx: CheckContext = {
  label: 'sabotaged fixture',
  before: '<mutated>',
  after: '<mutated>',
  options: {},
};

const diffFactory = (): DiffPair => {
  const [before, after] = buildLongContextFactory();
  return new Differ().diff(before, after) as unknown as DiffPair;
};

const clonePair = (pair: DiffPair): DiffPair => [
  pair[0].map(line => ({ ...line })),
  pair[1].map(line => ({ ...line })),
];

describe('contract catches sabotage: line numbers', () => {
  it('detects a swapped (non-increasing) right-side line number pair', () => {
    const [left, right] = clonePair(diffFactory());
    const visibleIndices = right.map((line, index) => index).filter(index => right[index].lineNumber !== undefined);
    const first = visibleIndices[4];
    const second = visibleIndices[5];
    const saved = right[first].lineNumber;
    right[first].lineNumber = right[second].lineNumber;
    right[second].lineNumber = saved;
    expect(() => checkLineNumbersAndShape([left, right], ctx)).toThrow(/line numbers/);
  });

  it('detects a duplicate right-side line number', () => {
    const [left, right] = clonePair(diffFactory());
    const visible = right.filter(line => line.lineNumber !== undefined);
    visible[6].lineNumber = visible[5].lineNumber;
    expect(() => checkLineNumbersAndShape([left, right], ctx)).toThrow(ContractError);
  });

  it('detects a blank placeholder that wrongly carries a line number', () => {
    // Remove a key so the right column contains blank alignment rows.
    const pair = new Differ().diff({ a: 1, gone: 2 }, { a: 1 }) as unknown as DiffPair;
    const [left, right] = clonePair(pair);
    const blankIndex = right.findIndex(line => line.text === '');
    expect(blankIndex).toBeGreaterThan(0);
    right[blankIndex].lineNumber = 999;
    expect(() => checkLineNumbersAndShape([left, right], ctx)).toThrow(/blank placeholder/);
  });
});

describe('contract catches sabotage: placeholder spans', () => {
  const fold = { threshold: 9, margin: 2 };

  it('detects a placeholder that would hide a changed row', () => {
    const intact = diffFactory();
    expect(() => checkFoldSegments(intact, ctx, fold)).not.toThrow();

    // Pick a row that the intact model really hides inside a placeholder.
    const segments = getSegments(intact[0], intact[1], fold, false);
    const expand = segments.find(segment => isExpandLine(segment));
    expect(expand).toBeDefined();
    const hiddenRow = Math.floor((expand!.start + expand!.end) / 2);

    const [left, right] = clonePair(intact);
    left[hiddenRow].type = 'remove';
    right[hiddenRow].type = 'add';

    // Feed the stale-but-intact partition against the corrupted model: the
    // guard must refuse to hide a row that is no longer common context.
    expect(() => checkPlaceholderRows(segments, [left, right], { ...ctx, label: 'sabotaged fold' }))
      .toThrow(/non-context/);
  });

  it('detects column length desynchronization', () => {
    const [left, right] = clonePair(diffFactory());
    left.pop();
    expect(() => checkLineNumbersAndShape([left, right], ctx)).toThrow(/length mismatch/);
  });
});

describe('contract catches sabotage: inline segment endpoints', () => {
  const pair: DiffPair = [
    [{ level: 0, type: 'modify', text: 'abcdef', lineNumber: 1 }],
    [{ level: 0, type: 'modify', text: 'abcXef', lineNumber: 1 }],
  ];

  it('passes the intact inline model', () => {
    expect(() => checkInlineSegments(pair, ctx)).not.toThrow();
  });

  it('detects an endpoint overflowing the right-side string', () => {
    const sabotaged = (l: string, r: string, options: Parameters<typeof getInlineDiff>[2]) => {
      const [segmentsL, segmentsR] = getInlineDiff(l, r, options);
      const corruptedR = segmentsR.map((segment): InlineDiffResult => ({
        ...segment,
        end: segment.end + r.length + 1,
      }));
      return [segmentsL, corruptedR] as [InlineDiffResult[], InlineDiffResult[]];
    };
    expect(() => checkInlineSegments(pair, ctx, undefined, sabotaged as typeof getInlineDiff)).toThrow(/overflows/);
  });

  it('detects overlapping segments injected on the left side', () => {
    const sabotaged = (l: string, r: string, options: Parameters<typeof getInlineDiff>[2]) => {
      const [segmentsL, segmentsR] = getInlineDiff(l, r, options);
      const corruptedL: InlineDiffResult[] = [
        ...segmentsL,
        { type: 'remove' as const, start: 0, end: 2 },
      ].sort((a, b) => a.start - b.start);
      return [corruptedL, segmentsR] as [InlineDiffResult[], InlineDiffResult[]];
    };
    expect(() => checkInlineSegments(pair, ctx, undefined, sabotaged as typeof getInlineDiff)).toThrow(/overlap|reorder/);
  });

  it('detects a gap between segments on the right side', () => {
    const sabotaged = (l: string, r: string, options: Parameters<typeof getInlineDiff>[2]) => {
      const [segmentsL, segmentsR] = getInlineDiff(l, r, options);
      const corruptedR = segmentsR.map(segment =>
        segment.type === 'add' ? { ...segment, start: segment.start + 1 } : segment,
      );
      return [segmentsL, corruptedR] as [InlineDiffResult[], InlineDiffResult[]];
    };
    expect(() => checkInlineSegments(pair, ctx, undefined, sabotaged as typeof getInlineDiff)).toThrow(/gap/);
  });
});
