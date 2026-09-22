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

const buildSegments = <T extends string | unknown[]>(
  leftItems: T,
  rightItems: T,
  lengthOf: (items: T) => number,
): [InlineDiffResult[], InlineDiffResult[]] => {
  const resultL: InlineDiffResult[] = [];
  const resultR: InlineDiffResult[] = [];
  let lastL = 0;
  let lastR = 0;

  const operations = [...myersDiff(leftItems, rightItems)] as Array<[number, number, number, number]>;
  for (const [startL, endL, startR, endR] of operations) {
    if (startL > lastL || startR > lastR) {
      const commonLength = Math.min(startL - lastL, startR - lastR);
      if (commonLength > 0) {
        resultL.push({ start: lastL, end: lastL + commonLength });
        resultR.push({ start: lastR, end: lastR + commonLength });
        lastL += commonLength;
        lastR += commonLength;
      }
      if (startL > lastL) {
        resultL.push({ type: 'remove', start: lastL, end: startL });
        lastL = startL;
      }
      if (startR > lastR) {
        resultR.push({ type: 'add', start: lastR, end: startR });
        lastR = startR;
      }
    }
    const removedLength = endL - startL;
    const addedLength = endR - startR;
    if (removedLength > 0) {
      resultL.push({ type: 'remove', start: startL, end: endL });
      lastL = endL;
    }
    if (addedLength > 0) {
      resultR.push({ type: 'add', start: startR, end: endR });
      lastR = endR;
    }
  }

  const totalL = lengthOf(leftItems);
  const totalR = lengthOf(rightItems);
  if (lastL < totalL || lastR < totalR) {
    const commonLength = Math.min(totalL - lastL, totalR - lastR);
    if (commonLength > 0) {
      resultL.push({ start: lastL, end: lastL + commonLength });
      resultR.push({ start: lastR, end: lastR + commonLength });
      lastL += commonLength;
      lastR += commonLength;
    }
  }
  if (totalL > lastL) {
    resultL.push({ type: 'remove', start: lastL, end: totalL });
  }
  if (totalR > lastR) {
    resultR.push({ type: 'add', start: lastR, end: totalR });
  }

  return [
    resultL.filter(item => item.end > item.start),
    resultR.filter(item => item.end > item.start),
  ];
};

const getInlineDiff = (l: string, r: string, options: InlineDiffOptions): [
  InlineDiffResult[],
  InlineDiffResult[]
] => {
  if (options.mode === 'word') {
    const wordSeparator = options.wordSeparator || ' ';
    const lArr = l.split(wordSeparator);
    const rArr = r.split(wordSeparator);

    const indicesOf = (arr: string[]) => {
      const result: number[] = [];
      let index = 0;
      for (const item of arr) {
        result.push(index);
        index += item.length + wordSeparator.length;
      }
      result.push(index - wordSeparator.length);
      return result;
    };
    const indicesL = indicesOf(lArr);
    const indicesR = indicesOf(rArr);

    const mapToOriginal = (
      segments: InlineDiffResult[],
      indices: number[],
      textLength: number,
    ): InlineDiffResult[] => segments.map(segment => ({
      ...segment,
      start: indices[segment.start],
      end: segment.end === indices.length - 1
        ? textLength
        : indices[segment.end],
    }));

    const [wordSegmentsL, wordSegmentsR] = buildSegments(lArr, rArr, items => items.length);
    return [
      mapToOriginal(wordSegmentsL, indicesL, l.length),
      mapToOriginal(wordSegmentsR, indicesR, r.length),
    ];
  }

  return buildSegments(l, r, items => items.length);
};

export default getInlineDiff;
