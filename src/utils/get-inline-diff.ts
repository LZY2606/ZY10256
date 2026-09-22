import { diff as myersDiff } from 'fast-myers-diff';

export interface InlineDiffOptions {
  mode?: 'char' | 'word';
  wordSeparator?: string;
}

export interface InlineDiffResult {
  type?: 'add' | 'remove';
  start: number;
  end: number;
}

const getOriginalIndices = (arr: string[], separatorLength: number) => {
  const result: number[] = [];
  let index = 0;
  for (const item of arr) {
    result.push(index);
    index += item.length + separatorLength;
  }
  result.push(index - separatorLength);
  return result;
};

const filterEmptyParts = (arr: InlineDiffResult[]) => {
  return arr.filter(item => item.end > item.start);
};

/**
 * `myersDiff` (the `diff` export of fast-myers-diff) yields change hunks as
 * `[startLeft, endLeft, startRight, endRight]`; the unchanged parts are the
 * gaps between consecutive hunks. Both sides are walked simultaneously so the
 * emitted segments always tile `[0, length)` without gaps or overlaps.
 */
const buildSegments = (
  hunks: Iterable<[number, number, number, number]>,
  lengthLeft: number,
  lengthRight: number,
  indexLeft: (wordIndex: number) => number,
  indexRight: (wordIndex: number) => number,
): [InlineDiffResult[], InlineDiffResult[]] => {
  const resultL: InlineDiffResult[] = [];
  const resultR: InlineDiffResult[] = [];
  let lastL = 0;
  let lastR = 0;
  for (const [startL, endL, startR, endR] of hunks) {
    if (startL > lastL) {
      resultL.push({ start: indexLeft(lastL), end: indexLeft(startL) });
      resultR.push({ start: indexRight(lastR), end: indexRight(startR) });
    }
    if (endL > startL) {
      resultL.push({ type: 'remove', start: indexLeft(startL), end: indexLeft(endL) });
    }
    if (endR > startR) {
      resultR.push({ type: 'add', start: indexRight(startR), end: indexRight(endR) });
    }
    lastL = endL;
    lastR = endR;
  }
  if (lengthLeft > lastL) {
    resultL.push({ start: indexLeft(lastL), end: indexLeft(lengthLeft) });
    resultR.push({ start: indexRight(lastR), end: indexRight(lengthRight) });
  }
  return [filterEmptyParts(resultL), filterEmptyParts(resultR)];
};

const getInlineDiff = (l: string, r: string, options: InlineDiffOptions): [
  InlineDiffResult[],
  InlineDiffResult[]
] => {
  if (options.mode === 'word') {
    const wordSeparator = options.wordSeparator || ' ';
    const lArr = l.split(wordSeparator);
    const rArr = r.split(wordSeparator);

    const separatorLength = wordSeparator.length;
    const indicesL = getOriginalIndices(lArr, separatorLength);
    const indicesR = getOriginalIndices(rArr, separatorLength);

    return buildSegments(
      myersDiff(lArr, rArr),
      lArr.length,
      rArr.length,
      index => indicesL[index],
      index => indicesR[index],
    );
  }

  return buildSegments(
    myersDiff(l, r),
    l.length,
    r.length,
    index => index,
    index => index,
  );
};

export default getInlineDiff;
