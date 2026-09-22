import Differ from '../../src/differ';
import type { DifferOptions } from '../../src/differ';
import getSegments from '../../src/utils/get-segments';
import getInlineDiff from '../../src/utils/get-inline-diff';
import { isExpandLine } from '../../src/utils/segment-util';
import { checkDiffContract } from './contract';
import type { DiffPair } from './contract';
import { assertReplayDeepEquals, lcsLength, countScriptEdits, replayPair } from './patch';
import { assertVirtualWindowConsistency, buildLayout } from './virtual-model';
import type { JsonValue } from './generator';

/**
 * Hand-directed edge cases for the model contracts. These complement the
 * seeded fuzz loop with shapes that are awkward to rely on by chance:
 * zero context, exact threshold runs, two adjacent fold zones, root value
 * replacement and empty containers.
 */

const runContract = (
  before: JsonValue,
  after: JsonValue,
  options: DifferOptions,
  fold: any = false,
  expectedFolds?: number,
): DiffPair => {
  const pair = new Differ(options).diff(before, after) as unknown as DiffPair;
  checkDiffContract(pair, {
    label: `targeted ${JSON.stringify(options)}`,
    before,
    after,
    options,
  }, { inline: true, fold, expectedFolds });
  assertReplayDeepEquals(pair, before, after, 'targeted');
  return pair;
};

/**
 * Build a root-array diff whose only equal run is `[` + `contextLength`
 * unchanged elements + `]`; the first/last elements are the surrounding edits.
 * Equal-run row count is therefore exactly contextLength + 2.
 */
const buildLongContextPair = (contextLength: number): [JsonValue, JsonValue] => {
  const before: JsonValue[] = ['HEAD-CHANGED', ...Array.from({ length: contextLength }, (_, index) => `keep-${index}`), 'TAIL-CHANGED'];
  const after: JsonValue[] = ['head-changed', ...Array.from({ length: contextLength }, (_, index) => `keep-${index}`), 'tail-changed'];
  return [before, after];
};

describe('targeted: fold threshold boundary', () => {
  const fold = { threshold: 9, margin: 2 };

  it('does not fold a run shorter than the threshold', () => {
    // Six elements render as opener + 6 values + closer = 8 equal rows (< 9).
    const [before, after] = buildLongContextPair(6);
    const pair = new Differ().diff(before, after) as unknown as DiffPair;
    const segments = getSegments(pair[0], pair[1], fold, false);
    expect(segments.some(segment => isExpandLine(segment))).toBe(false);
    runContract(before, after, {}, fold, 0);
  });

  it('folds a run whose length equals the threshold exactly', () => {
    // Nine unchanged elements form an equal run of exactly 9 rows (the threshold);
    // the bracket rows are separate, smaller runs that stay unfolded.
    const [before, after] = buildLongContextPair(9);
    const pair = runContract(before, after, {}, fold, 1);
    const segments = getSegments(pair[0], pair[1], fold, false);
    const expand = segments.filter(segment => isExpandLine(segment));
    expect(expand).toHaveLength(1);
    // The kept context is exactly `margin` rows on each side.
    const hidden = expand[0];
    if (!isExpandLine(hidden)) {
      throw new Error('expected the single fold to be an expand placeholder');
    }
    expect(hidden.end - hidden.start).toBe(9 - 2 * fold.margin);
    expect(hidden.hasLinesBefore).toBe(true);
    expect(hidden.hasLinesAfter).toBe(true);
  });
});

describe('targeted: zero context', () => {
  it('completely different scalar arrays produce only add/remove rows and one change segment', () => {
    const before = [1, 2, 3];
    const after = [4, 5, 6];
    const options = { arrayDiffMethod: 'lcs' as const, showModifications: false };
    const pair = runContract(before, after, options, false);
    const segments = getSegments(pair[0], pair[1], { threshold: 2, margin: 0 }, false);
    const changeSegments = segments.filter(segment => !segment.isEqual);
    expect(changeSegments).toHaveLength(1);
    expect(isExpandLine(changeSegments[0])).toBe(false);
    // Bracket rows remain shared framing; everything between them changes.
    expect(pair[0].slice(1, -1).every(line => line.type === 'remove' || line.text === '')).toBe(true);
    expect(pair[1].slice(1, -1).every(line => line.type === 'add' || line.text === '')).toBe(true);
  });

  it('root scalar replacement has no shared row at all', () => {
    const before = 42;
    const after = 'answer';
    const pair = new Differ().diff(before, after) as unknown as DiffPair;
    checkDiffContract(pair, { label: 'root scalar', before, after, options: {} }, { inline: false, fold: false });
    // A type change at the root is emitted as remove/add (the two scalar
    // serializations never share a frame); the contract is the absence of any
    // equal context and a replay that restores both values.
    expect(pair[0].filter(line => line.text !== '').map(line => line.type)).toEqual(['remove']);
    expect(pair[1].filter(line => line.text !== '').map(line => line.type)).toEqual(['add']);
    assertReplayDeepEquals(pair, before, after, 'root scalar');
  });
});

describe('targeted: two consecutive fold zones', () => {
  it('two separated long equal runs stay as two independent placeholders', () => {
    // Two long unchanged arrays, separated by a modified scalar field.
    const before: Record<string, JsonValue> = {
      a: Array.from({ length: 12 }, (_, index) => `a-${index}`),
      pivot: 1,
      b: Array.from({ length: 14 }, (_, index) => `b-${index}`),
    };
    const after: Record<string, JsonValue> = {
      a: Array.from({ length: 12 }, (_, index) => `a-${index}`),
      pivot: 2,
      b: Array.from({ length: 14 }, (_, index) => `b-${index}`),
    };
    const fold = { threshold: 8, margin: 1 };
    const pair = runContract(before, after, { preserveKeyOrder: 'before' }, fold, 2);
    const segments = getSegments(pair[0], pair[1], fold, false);
    const expand = segments.filter(segment => isExpandLine(segment));
    expect(expand).toHaveLength(2);
    // Hidden ranges never overlap and stay in order.
    for (let i = 1; i < expand.length; i++) {
      expect(expand[i].start).toBeGreaterThanOrEqual(expand[i - 1].end);
    }
    // Virtual-list layout agrees at every pixel, including both fold borders.
    assertVirtualWindowConsistency(pair, fold, 'two fold zones');
  });
});

describe('targeted: root value replacement', () => {
  const cases: Array<[string, JsonValue, JsonValue]> = [
    ['object -> array', { a: 1, b: 2 }, [1, 2]],
    ['array -> object', [1, 2, 3], { x: 1 }],
    ['object -> null', { deep: { value: 1 } }, null],
    ['null -> array', null, [1, 2]],
    ['string -> object', 'text', { replaced: true }],
    ['number -> boolean', 0, false],
  ];
  it.each(cases)('%s replays and keeps balanced columns', (_name, before, after) => {
    const pair = new Differ().diff(before, after) as unknown as DiffPair;
    checkDiffContract(pair, { label: `root replace ${_name}`, before, after, options: {} }, { inline: false, fold: false });
    assertReplayDeepEquals(pair, before, after, `root ${_name}`);
  });
});

describe('targeted: empty containers', () => {
  it('both sides empty object is a single equal framing', () => {
    const before = {};
    const after = {};
    const pair = new Differ().diff(before, after) as unknown as DiffPair;
    expect(pair[0]).toHaveLength(2);
    checkDiffContract(pair, { label: 'empty objects', before, after, options: {} }, { inline: false, fold: { threshold: 1, margin: 0 } });
  });

  it('empty array becoming non-empty replays', () => {
    const before: JsonValue = { list: [] };
    const after: JsonValue = { list: [1, 2, 3] };
    runContract(before, after, {}, false);
  });

  it('non-empty container emptied on one side replays', () => {
    const before: JsonValue = { nested: { keep: 1, gone: [1, 2, 3] } };
    const after: JsonValue = { nested: { keep: 1, gone: [] } };
    runContract(before, after, { preserveKeyOrder: 'after' }, false);
  });
});

describe('targeted: virtual window geometry over folded/unfolded boundaries', () => {
  it('layout height uses half-open segment ranges on both code paths', () => {
    const [before, after] = buildLongContextPair(20);
    const fold = { threshold: 8, margin: 2 };
    const pair = new Differ().diff(before, after) as unknown as DiffPair;
    const layout = buildLayout(pair, fold);
    // Every accumulated top is non-decreasing and the total is positive.
    for (let i = 1; i < layout.accTops.length; i++) {
      expect(layout.accTops[i]).toBeGreaterThan(layout.accTops[i - 1]);
    }
    assertVirtualWindowConsistency(pair, fold, 'boundary geometry');
  });
});

describe('targeted: LCS ties only promise replay + minimum edits', () => {
  // Repeated values admit several optimal alignments; the library may choose
  // any, but the edit count must be the LCS minimum.
  it('repeated-element arrays emit exactly |A|+|B|-2*LCS edit rows', () => {
    const before = [1, 1, 2, 1, 2, 2, 3, 1];
    const after = [2, 1, 2, 3, 3, 1, 2];
    const options = { arrayDiffMethod: 'lcs' as const };
    const pair = new Differ(options).diff(before, after) as unknown as DiffPair;
    checkDiffContract(pair, { label: 'lcs ties', before, after, options }, { inline: false, fold: false });
    assertReplayDeepEquals(pair, before, after, 'lcs ties');
    // With modifications recognized, every non-shared scalar row is either one
    // remove or one add; ties do not change the minimum total.
    expect(countScriptEdits(pair)).toBe(before.length + after.length - 2 * lcsLength(before, after));
  });

  it('insertions only are minimum edits under every scalar-array tie', () => {
    const before = [7, 7, 7];
    const after = [7, 7, 7, 7, 7];
    const pair = new Differ({ arrayDiffMethod: 'lcs' }).diff(before, after) as unknown as DiffPair;
    assertReplayDeepEquals(pair, before, after, 'lcs ties insert');
    expect(countScriptEdits(pair)).toBe(after.length - before.length);
  });
});


describe('targeted: array methods and key-order configurations', () => {
  it('compare-key replays without losing unmatched objects', () => {
    const before: JsonValue = [
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
      { id: 'c', value: 3 },
    ];
    const after: JsonValue = [
      { id: 'b', value: 20 },
      { id: 'a', value: 1 },
      { id: 'd', value: 4 },
    ];
    const options = { arrayDiffMethod: 'compare-key' as const, compareKey: 'id' };
    const pair = new Differ(options).diff(before, after) as unknown as DiffPair;
    checkDiffContract(pair, { label: 'compare-key', before, after, options }, { inline: false, fold: false });
    const replayed = replayPair(pair, 'compare-key');
    // compare-key is documented as order-agnostic: matched rows are rendered
    // alongside their left-side peers, so compare by the configured key.
    const keyOf = (item: any) => String(item.id);
    expect(replayed.rightDocument).toBeDefined();
    expect([...(replayed.rightDocument as Record<string, unknown>[])].sort((a, b) => keyOf(a).localeCompare(keyOf(b))))
      .toEqual([...after].sort((a, b) => keyOf(a).localeCompare(keyOf(b))));
    const sortedBefore = [...before].sort((a, b) => keyOf(a).localeCompare(keyOf(b))) as JsonValue[];
    assertReplayDeepEquals(pair, sortedBefore, [...after].sort((a, b) => keyOf(a).localeCompare(keyOf(b))) as JsonValue[], 'compare-key-ordered');
  });

  it('preserveKeyOrder values follow each configured side, not native enumeration', () => {
    const before: JsonValue = { zulu: 1, alpha: 2, mike: [1] };
    const after: JsonValue = { yankee: 10, alpha: 2, mike: [2] };
    for (const preserveKeyOrder of ['before', 'after'] as const) {
      const options = { preserveKeyOrder };
      const pair = new Differ(options).diff(before, after) as unknown as DiffPair;
      checkDiffContract(pair, { label: `order-${preserveKeyOrder}`, before, after, options }, { inline: false, fold: false });
      assertReplayDeepEquals(pair, before, after, `order-${preserveKeyOrder}`);
    }
  });

  it('default (sorted) configuration emits object keys in ascending lexical order', () => {
    const before: JsonValue = { zulu: 1, alpha: 1, mike: 1 };
    const pair = new Differ().diff(before, before) as unknown as DiffPair;
    const keys = pair[0]
      .map(line => line.text.match(/^"([^"]+)":/)?.[1])
      .filter((key): key is string => !!key);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });
});


describe('targeted: inline diff endpoint regression cases', () => {
  const apply = (text: string, segments: Array<{ start: number; end: number; type?: string }>) =>
    segments.map(segment => text.slice(segment.start, segment.end)).join('');

  it('keeps right-side endpoints inside the shorter string with no common prefix', () => {
    // Regression for the `lcs` 4-tuple coordinate misuse: right interval used
    // to overflow to the left string length.
    const [left, right] = getInlineDiff('s'.repeat(49), '9', { mode: 'char' });
    expect(right).toEqual([{ type: 'add', start: 0, end: 1 }]);
    expect(left).toEqual([{ type: 'remove', start: 0, end: 49 }]);
  });

  it('rebuilds both strings in char and word mode', () => {
    const cases: Array<[string, string]> = [
      ['hello world', 'hello worlds'],
      ['abc', 'axc'],
      ['one two three', 'one 2 three'],
      ['', 'x'],
      ['abcdef', 'abcdef'],
    ];
    for (const [l, r] of cases) {
      for (const options of [{ mode: 'char' as const }, { mode: 'word' as const, wordSeparator: ' ' }]) {
        const [segmentsL, segmentsR] = getInlineDiff(l, r, options);
        expect(apply(l, segmentsL)).toBe(l);
        expect(apply(r, segmentsR)).toBe(r);
        expect(segmentsL.every(segment => segment.end <= l.length)).toBe(true);
        expect(segmentsR.every(segment => segment.end <= r.length)).toBe(true);
      }
    }
  });
});
