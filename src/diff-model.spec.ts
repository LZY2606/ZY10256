import Differ from './differ';
import type { DiffResult } from './differ';
import getInlineDiff from './utils/get-inline-diff';
import getSegments from './utils/get-segments';
import { isExpandLine } from './utils/segment-util';
import {
  checkDiffModel,
  checkInlineSegments,
  checkLineNumbers,
  checkSegments,
  replayRightValue,
} from './testkit/diff-model';
import type { DiffModelCase } from './testkit/diff-model';
import { assertDiffModel, shrinkCase } from './testkit/shrink';
import { generateJson, mutateJson } from './testkit/json-fuzz';
import type { JsonValue } from './testkit/json-fuzz';
import { createRng, pickInt, pickOne } from './testkit/seeded-random';

const baseCase = (sourceLeft: JsonValue, sourceRight: JsonValue): DiffModelCase => ({
  sourceLeft,
  sourceRight,
  differOptions: {},
  fold: { threshold: 8, margin: 3 },
});

describe('diff model: directed coverage', () => {
  it('root value replacement (scalar modify, type change, container swap)', () => {
    assertDiffModel(baseCase(1, 2));
    assertDiffModel(baseCase('lorem ipsum dolor sit', 'lorem ipsum dolor amet'));
    assertDiffModel(baseCase({ alpha: 1 }, [1, 2, 3]));
    assertDiffModel(baseCase([1, 2, 3], 'scalar'));
    assertDiffModel(baseCase(null, { beta: [true, null] }));
  });

  it('empty containers on both sides and against content', () => {
    assertDiffModel(baseCase({}, {}));
    assertDiffModel(baseCase([], []));
    assertDiffModel(baseCase({}, []));
    assertDiffModel(baseCase([], {}));
    assertDiffModel(baseCase({}, { alpha: 1 }));
    assertDiffModel(baseCase({ alpha: {} }, { alpha: [] }));
    assertDiffModel(baseCase([], [[]]));
    assertDiffModel(baseCase({ alpha: { beta: {} } }, { alpha: { beta: { gamma: 1 } } }));
  });

  it('zero context: margin 0 hides a full equal run', () => {
    const testCase: DiffModelCase = {
      sourceLeft: [0, 1, 2, 3],
      sourceRight: [0, 1, 2, 99],
      differOptions: {},
      fold: { threshold: 3, margin: 0 },
    };
    assertDiffModel(testCase);
    const differ = new Differ();
    const [left, right] = differ.diff(testCase.sourceLeft, testCase.sourceRight);
    const segments = getSegments(left, right, { ...testCase.fold }, false);
    const hidden = segments.filter(isExpandLine);
    expect(hidden).toHaveLength(1);
    expect([hidden[0].start, hidden[0].end]).toEqual([0, 4]);
  });

  it('exactly threshold: run of threshold lines is hidden, threshold - 1 is not', () => {
    // rows: `[`, 0, 1, 2 (4 equal rows), modify row, `]` (1 equal row)
    const atThreshold: DiffModelCase = {
      sourceLeft: [0, 1, 2, 3],
      sourceRight: [0, 1, 2, 99],
      differOptions: {},
      fold: { threshold: 4, margin: 1 },
    };
    assertDiffModel(atThreshold);
    const differ = new Differ();
    const [left, right] = differ.diff(atThreshold.sourceLeft, atThreshold.sourceRight);
    expect(getSegments(left, right, { ...atThreshold.fold }, false).filter(isExpandLine)).toHaveLength(1);

    const belowThreshold: DiffModelCase = { ...atThreshold, fold: { threshold: 5, margin: 1 } };
    assertDiffModel(belowThreshold);
    expect(getSegments(left, right, { ...belowThreshold.fold }, false).filter(isExpandLine)).toHaveLength(0);
  });

  it('two consecutive fold regions around a single change', () => {
    const testCase: DiffModelCase = {
      sourceLeft: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      sourceRight: [0, 1, 2, 3, 4, 99, 6, 7, 8, 9],
      differOptions: {},
      fold: { threshold: 4, margin: 1 },
    };
    assertDiffModel(testCase);
    const differ = new Differ();
    const [left, right] = differ.diff(testCase.sourceLeft, testCase.sourceRight);
    const hidden = getSegments(left, right, { ...testCase.fold }, false).filter(isExpandLine);
    expect(hidden).toHaveLength(2);
    expect([hidden[0].start, hidden[0].end]).toEqual([0, 5]);
    expect([hidden[1].start, hidden[1].end]).toEqual([8, 12]);
  });

  it('long string single-character change yields minimal inline segments', () => {
    const before = `${'lorem ipsum '.repeat(20)}X${' dolor sit'.repeat(20)}`;
    const after = `${'lorem ipsum '.repeat(20)}Y${' dolor sit'.repeat(20)}`;
    assertDiffModel(baseCase(before, after));
    const [segmentsLeft, segmentsRight] = getInlineDiff(before, after, { mode: 'char' });
    expect(checkInlineSegments(before, after, segmentsLeft, segmentsRight)).toBeNull();
    expect(segmentsLeft.filter(s => s.type === 'remove')).toHaveLength(1);
    expect(segmentsRight.filter(s => s.type === 'add')).toHaveLength(1);
    expect(segmentsLeft.find(s => s.type === 'remove')).toMatchObject({ start: 240, end: 241 });
  });

  it('object key order follows library configuration, not enumeration accidents', () => {
    const topLevelKeys = (lines: DiffResult[]) => lines
      .filter(line => line.level === 1 && line.text.startsWith('"'))
      .map(line => line.text.match(/^"([^"]*)":/)![1]);

    const left = { beta: 1, alpha: 2 };
    const right = { alpha: 2, beta: 1, gamma: 3 };

    const differDefault = new Differ();
    const [dl, dr] = differDefault.diff(left, right);
    // Default configuration sorts keys on both sides.
    expect(topLevelKeys(dl)).toEqual(['alpha', 'beta']);
    expect(topLevelKeys(dr)).toEqual(['alpha', 'beta', 'gamma']);

    const differBefore = new Differ({ preserveKeyOrder: 'before' });
    const [bl, br] = differBefore.diff(left, right);
    expect(topLevelKeys(bl)).toEqual(['beta', 'alpha']);
    expect(topLevelKeys(br)).toEqual(['beta', 'alpha', 'gamma']);

    const differAfter = new Differ({ preserveKeyOrder: 'after' });
    const [al, ar] = differAfter.diff(left, right);
    expect(topLevelKeys(al)).toEqual(['alpha', 'beta']);
    expect(topLevelKeys(ar)).toEqual(['alpha', 'beta', 'gamma']);

    // Replay stays valid under every key-order configuration.
    for (const preserveKeyOrder of [undefined, 'before', 'after'] as const) {
      assertDiffModel({ ...baseCase(left, right), differOptions: { preserveKeyOrder } });
    }
  });

  it('array LCS ties: replayable and minimal, without pinning one path', () => {
    const lcsLength = (a: JsonValue[], b: JsonValue[]): number => {
      const f = Array(a.length + 1).fill(0).map(() => Array(b.length + 1).fill(0));
      for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
          f[i][j] = JSON.stringify(a[i - 1]) === JSON.stringify(b[j - 1])
            ? f[i - 1][j - 1] + 1
            : Math.max(f[i - 1][j], f[i][j - 1]);
        }
      }
      return f[a.length][b.length];
    };
    const countTypes = (lines: DiffResult[], type: string) => lines.filter(l => l.type === type).length;

    // [1, 2] vs [2, 1] has two equally optimal LCS paths; [1,2,3] vs [3,2,1] too.
    for (const [sourceLeft, sourceRight] of [
      [[1, 2], [2, 1]],
      [[1, 2, 3], [3, 2, 1]],
      [[1, 2, 3, 4], [2, 4, 1, 3]],
    ] as Array<[JsonValue[], JsonValue[]]>) {
      const minimal = (sourceLeft.length - lcsLength(sourceLeft, sourceRight)) +
        (sourceRight.length - lcsLength(sourceLeft, sourceRight));

      const testCase: DiffModelCase = {
        sourceLeft,
        sourceRight,
        differOptions: { arrayDiffMethod: 'lcs', showModifications: false },
        fold: { threshold: 8, margin: 3 },
      };
      assertDiffModel(testCase);

      const differ = new Differ(testCase.differOptions);
      const [left, right] = differ.diff(sourceLeft, sourceRight);
      const edits = countTypes(left, 'remove') + countTypes(right, 'add');
      expect(edits).toBe(minimal);
      expect(replayRightValue(left, right)).toEqual(sourceRight);

      // With modifications enabled the visible edit count may only shrink.
      const differModify = new Differ({ arrayDiffMethod: 'lcs', showModifications: true });
      const [ml, mr] = differModify.diff(sourceLeft, sourceRight);
      expect(countTypes(ml, 'remove') + countTypes(mr, 'add')).toBeLessThanOrEqual(minimal);
      assertDiffModel({ ...testCase, differOptions: { arrayDiffMethod: 'lcs', showModifications: true } });
    }
  });
});

describe('diff model: seeded property tests', () => {
  const SEEDS = 100;
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}: generated pair survives every contract`, () => {
      const rng = createRng(seed);
      const sourceLeft = generateJson(rng, 3);
      const sourceRight = mutateJson(rng, sourceLeft, pickInt(rng, 1, 4));
      const margin = pickInt(rng, 0, 2);
      const testCase: DiffModelCase = {
        sourceLeft,
        sourceRight,
        differOptions: {
          arrayDiffMethod: pickOne(rng, ['normal', 'lcs'] as const),
          showModifications: pickOne(rng, [true, false] as const),
          preserveKeyOrder: pickOne(rng, [undefined, 'before', 'after'] as const),
        },
        fold: { threshold: margin * 2 + 2 + pickInt(rng, 0, 5), margin },
      };
      assertDiffModel(testCase);
    });
  }
});

describe('diff model: contracts catch deliberate corruption', () => {
  it('shrinks failing JSON and fold parameters to a minimal case', () => {
    const testCase: DiffModelCase = {
      sourceLeft: { alpha: [1, 2, 3], beta: { gamma: 'x' }, delta: true },
      sourceRight: { alpha: [1, 2, 3], beta: { gamma: 'y' }, delta: true },
      differOptions: {},
      fold: { threshold: 9, margin: 3 },
    };
    // A synthetic contract that fails whenever both sides have `beta.gamma`
    // and it differs: everything unrelated must be shrunk away.
    const check = (candidate: DiffModelCase) => {
      const gammaLeft = (candidate.sourceLeft as any)?.beta?.gamma;
      const gammaRight = (candidate.sourceRight as any)?.beta?.gamma;
      return gammaLeft !== undefined && gammaRight !== undefined && gammaLeft !== gammaRight
        ? 'gamma differs'
        : null;
    };
    const shrunk = shrinkCase(testCase, check);
    expect(check(shrunk)).not.toBeNull();
    expect(JSON.stringify(shrunk.sourceLeft)).toBe('{"beta":{"gamma":"x"}}');
    expect(JSON.stringify(shrunk.sourceRight)).toBe('{"beta":{"gamma":"y"}}');
    expect(shrunk.fold).toEqual({ threshold: 1, margin: 0 });
  });

  const makeModel = () => {
    const testCase: DiffModelCase = {
      sourceLeft: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      sourceRight: [0, 1, 2, 3, 4, 99, 6, 7, 8, 10],
      differOptions: {},
      fold: { threshold: 4, margin: 1 },
    };
    expect(checkDiffModel(testCase)).toBeNull();
    const differ = new Differ();
    const [left, right] = differ.diff(testCase.sourceLeft, testCase.sourceRight);
    const segments = getSegments(left, right, { ...testCase.fold }, false);
    return { left, right, segments, fold: testCase.fold };
  };

  it('catches non-increasing right line numbers', () => {
    const { left, right } = makeModel();
    const corrupted = right.map(line => ({ ...line }));
    const visible = corrupted.map((line, index) => ({ line, index })).filter(({ line }) => line.text);
    // Swap the line numbers of two neighbouring visible lines.
    const tmp = visible[2].line.lineNumber;
    visible[2].line.lineNumber = visible[3].line.lineNumber;
    visible[3].line.lineNumber = tmp;
    expect(checkLineNumbers(left, corrupted)).toMatch(/lineNumber/);
    // Dropping a line number entirely is caught as well.
    const missing = right.map(line => ({ ...line }));
    delete missing[1].lineNumber;
    expect(checkLineNumbers(left, missing)).toMatch(/lineNumber/);
  });

  it('catches a corrupted placeholder length', () => {
    const { left, right, segments, fold } = makeModel();
    expect(segments.some(isExpandLine)).toBe(true);
    const stretched = segments.map(segment => ({ ...segment }));
    const firstHidden = stretched.findIndex(isExpandLine);
    stretched[firstHidden] = { ...stretched[firstHidden], end: stretched[firstHidden].end + 1 };
    expect(checkSegments(left, right, stretched, fold)).toMatch(/segment|placeholder/);

    const shrunken = segments.map(segment => ({ ...segment }));
    shrunken[firstHidden] = { ...shrunken[firstHidden], end: shrunken[firstHidden].end - 1 };
    expect(checkSegments(left, right, shrunken, fold)).toMatch(/segment|placeholder/);
  });

  it('catches corrupted inline segment endpoints', () => {
    const textLeft = 'lorem ipsum dolor sit amet';
    const textRight = 'lorem ipsum dolor sic amet';
    const [segmentsLeft, segmentsRight] = getInlineDiff(textLeft, textRight, { mode: 'char' });
    expect(checkInlineSegments(textLeft, textRight, segmentsLeft, segmentsRight)).toBeNull();

    const shiftedRight = segmentsRight.map(segment => ({ ...segment }));
    shiftedRight[shiftedRight.length - 1].end += 1;
    expect(checkInlineSegments(textLeft, textRight, segmentsLeft, shiftedRight)).toMatch(/inline segment/);

    const shiftedLeft = segmentsLeft.map(segment => ({ ...segment }));
    shiftedLeft[1].start += 1;
    expect(checkInlineSegments(textLeft, textRight, shiftedLeft, segmentsRight)).toMatch(/inline segment/);
  });
});
