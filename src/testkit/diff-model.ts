import Differ from '../differ';
import type { DifferOptions, DiffResult } from '../differ';
import getInlineDiff from '../utils/get-inline-diff';
import type { InlineDiffResult } from '../utils/get-inline-diff';
import getSegments from '../utils/get-segments';
import type { HiddenUnchangedLinesInfo, SegmentItem } from '../utils/get-segments';
import { isExpandLine } from '../utils/segment-util';
import type { JsonValue } from './json-fuzz';

export interface FoldOptions {
  threshold: number;
  margin: number;
}

export type Path = Array<string | number>;

/**
 * Order-insensitive deep equal for JSON values: object key order is ignored
 * (the key order of a diff output is a library configuration concern, never a
 * JavaScript property-enumeration accident), array order is significant.
 */
export const deepEqualCanonical = (a: JsonValue, b: JsonValue): boolean => {
  if (a === b) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => deepEqualCanonical(item, (b as JsonValue[])[index]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  return keysA.every(key => (
    Object.prototype.hasOwnProperty.call(b, key) &&
    deepEqualCanonical(
      (a as Record<string, JsonValue>)[key],
      (b as Record<string, JsonValue>)[key],
    )
  ));
};

/**
 * Compute the logical path of every visible line by replaying the bracket
 * structure of one side. Lines without text (placeholders) get `null`.
 */
export const computeLinePaths = (lines: DiffResult[]): Array<Path | null> => {
  const paths: Array<Path | null> = [];
  const stack: Array<{ container: 'object' | 'array'; path: Path; nextIndex: number }> = [];
  for (const line of lines) {
    if (!line.text) {
      paths.push(null);
      continue;
    }
    const text = line.text;
    if (text === '}' || text === ']') {
      const top = stack.pop();
      paths.push(top ? top.path : []);
      continue;
    }
    const parent = stack[stack.length - 1];
    let path: Path;
    if (!parent) {
      path = [];
    } else if (parent.container === 'array') {
      path = [...parent.path, parent.nextIndex++];
    } else {
      const match = text.match(/^"([^"]*)":/);
      if (!match) {
        throw new Error(`Cannot parse object member line: ${text}`);
      }
      path = [...parent.path, match[1]];
    }
    paths.push(path);
    if (text.endsWith('{') || text.endsWith('[')) {
      stack.push({ container: text.endsWith('{') ? 'object' : 'array', path, nextIndex: 0 });
    }
  }
  return paths;
};

const buildSideDocument = (
  context: DiffResult[],
  changes: DiffResult[],
): string => {
  const parts: string[] = [];
  for (let i = 0; i < changes.length; i++) {
    const line = changes[i];
    if (!line.text) {
      continue;
    }
    // Unchanged context is taken from the *other* (source) side, changed
    // lines (add / modify) come from this side's diff operations.
    const text = line.type === 'equal' ? context[i].text : line.text;
    parts.push(line.comma ? `${text},` : text);
  }
  return parts.join('\n');
};

/**
 * Patch interpreter: rebuild the right-hand value purely from the diff
 * operations plus the unchanged context lines of the left-hand side.
 */
export const replayRightValue = (left: DiffResult[], right: DiffResult[]): JsonValue => {
  return JSON.parse(buildSideDocument(left, right));
};

/** Symmetric interpreter: rebuild the left-hand value from the right context. */
export const replayLeftValue = (left: DiffResult[], right: DiffResult[]): JsonValue => {
  return JSON.parse(buildSideDocument(right, left));
};

const pathToString = (path: Path | null): string => (
  path === null ? '<placeholder>' : `root${path.map(p => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('')}`
);

/** Contract 1: visible line numbers are consecutive 1..N on each side. */
export const checkLineNumbers = (left: DiffResult[], right: DiffResult[]): string | null => {
  if (left.length !== right.length) {
    return `row count mismatch: left has ${left.length} rows, right has ${right.length} rows`;
  }
  const sides: Array<[string, DiffResult[]]> = [['left', left], ['right', right]];
  for (const [name, lines] of sides) {
    let expected = 1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.text) {
        if (line.lineNumber !== undefined) {
          return `${name} row ${i} is a placeholder but has lineNumber ${line.lineNumber}`;
        }
        continue;
      }
      if (line.lineNumber !== expected) {
        return `${name} row ${i} ("${line.text}") has lineNumber ${line.lineNumber}, expected ${expected}`;
      }
      expected++;
    }
  }
  for (let i = 0; i < left.length; i++) {
    if (left[i].type === 'add') {
      return `left row ${i} has type "add" which must only appear on the right side`;
    }
    if (right[i].type === 'remove') {
      return `right row ${i} has type "remove" which must only appear on the left side`;
    }
    // Empty lines are alignment placeholders; the differ emits them with type
    // "equal", or "modify" when padding a multi-line modification.
    if (!left[i].text && left[i].type !== 'equal' && left[i].type !== 'modify') {
      return `left row ${i} is an empty placeholder with type "${left[i].type}"`;
    }
    if (!right[i].text && right[i].type !== 'equal' && right[i].type !== 'modify') {
      return `right row ${i} is an empty placeholder with type "${right[i].type}"`;
    }
  }
  return null;
};

/**
 * Normalize a path for cross-side comparison: array indices are wildcards
 * because inserted / removed elements legitimately shift the indices of the
 * common context (e.g. under LCS), while object keys and the container
 * structure must match exactly.
 */
const normalizePath = (path: Path | null): string => (
  path === null ? '<placeholder>' : JSON.stringify(path.map(p => (typeof p === 'number' ? '*' : p)))
);

/** Contract 2: common context rows refer to the same path on both sides. */
export const checkContextPaths = (left: DiffResult[], right: DiffResult[]): string | null => {
  const pathsLeft = computeLinePaths(left);
  const pathsRight = computeLinePaths(right);
  for (let i = 0; i < left.length; i++) {
    if (left[i].type !== 'equal' || right[i].type !== 'equal') {
      continue;
    }
    if (!left[i].text && !right[i].text) {
      continue;
    }
    if (left[i].text !== right[i].text) {
      return `equal row ${i} has diverging text: "${left[i].text}" vs "${right[i].text}"`;
    }
    if (normalizePath(pathsLeft[i]) !== normalizePath(pathsRight[i])) {
      return `equal row ${i} ("${left[i].text}") maps to ${pathToString(pathsLeft[i])} on the left ` +
        `but ${pathToString(pathsRight[i])} on the right`;
    }
  }
  return null;
};

/** Contract 3: replaying the diff operations reproduces both source values. */
export const checkReplay = (
  left: DiffResult[],
  right: DiffResult[],
  sourceLeft: JsonValue,
  sourceRight: JsonValue,
): string | null => {
  let rebuiltRight: JsonValue;
  let rebuiltLeft: JsonValue;
  try {
    rebuiltRight = replayRightValue(left, right);
  } catch (e) {
    return `right value cannot be rebuilt from the diff: ${(e as Error).message}`;
  }
  if (!deepEqualCanonical(rebuiltRight, sourceRight)) {
    return `rebuilt right value ${JSON.stringify(rebuiltRight)} differs from the target ${JSON.stringify(sourceRight)}`;
  }
  try {
    rebuiltLeft = replayLeftValue(left, right);
  } catch (e) {
    return `left value cannot be rebuilt from the diff: ${(e as Error).message}`;
  }
  if (!deepEqualCanonical(rebuiltLeft, sourceLeft)) {
    return `rebuilt left value ${JSON.stringify(rebuiltLeft)} differs from the source ${JSON.stringify(sourceLeft)}`;
  }
  return null;
};

const isEqualRow = (left: DiffResult[], right: DiffResult[], index: number): boolean => {
  return left[index].type === 'equal' && right[index].type === 'equal';
};

/** Contract 4: fold segments tile the model and only hide equal context. */
export const checkSegments = (
  left: DiffResult[],
  right: DiffResult[],
  segments: Array<SegmentItem | HiddenUnchangedLinesInfo>,
  fold: FoldOptions,
): string | null => {
  const total = left.length;
  if (!segments.length) {
    return total ? 'segments are empty but the model has rows' : null;
  }
  // Tiling: expanding every placeholder must restore the uncollapsed model.
  let cursor = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.start !== cursor) {
      return `segment ${i} starts at ${segment.start}, expected ${cursor} (gap or overlap)`;
    }
    if (segment.end < segment.start) {
      return `segment ${i} has negative length [${segment.start}, ${segment.end})`;
    }
    if (isExpandLine(segment) && segment.end === segment.start) {
      return `placeholder segment ${i} hides zero lines`;
    }
    cursor = segment.end;
  }
  if (cursor !== total) {
    return `segments end at ${cursor}, model has ${total} rows`;
  }
  // Placeholders may only cover equal context lines.
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!isExpandLine(segment)) {
      continue;
    }
    for (let row = segment.start; row < segment.end; row++) {
      if (!isEqualRow(left, right, row)) {
        return `placeholder segment ${i} hides changed row ${row} ` +
          `(left type "${left[row].type}", right type "${right[row].type}")`;
      }
    }
  }
  // Exact placeholder geometry, recomputed from the raw model: for every
  // hideable equal run there must be exactly one placeholder with the bounds
  // implied by threshold / margin, and no other run may be hidden.
  const runs: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < total; i++) {
    if (isEqualRow(left, right, i)) {
      if (runs.length && runs[runs.length - 1].end === i) {
        runs[runs.length - 1].end = i + 1;
      } else {
        runs.push({ start: i, end: i + 1 });
      }
    }
  }
  const hidden = segments.filter(isExpandLine);
  let hiddenIndex = 0;
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    const length = run.end - run.start;
    const hideable = length >= fold.threshold && length > fold.margin * 2 + 1;
    if (!hideable) {
      continue;
    }
    const placeholder = hidden[hiddenIndex++];
    if (!placeholder) {
      return `equal run [${run.start}, ${run.end}) of length ${length} should be hidden but no placeholder exists`;
    }
    // `getSegments` decides the placeholder shape from the position of the
    // raw run: a run touching row 0 uses the "first" branch even when it is
    // also the last one.
    const isFirst = run.start === 0;
    const isLast = !isFirst && run.end === total;
    const expectedStart = isFirst ? run.start : run.start + fold.margin;
    const expectedEnd = isLast ? run.end : run.end - fold.margin;
    if (placeholder.start !== expectedStart || placeholder.end !== expectedEnd) {
      return `placeholder for equal run [${run.start}, ${run.end}) is ` +
        `[${placeholder.start}, ${placeholder.end}), expected [${expectedStart}, ${expectedEnd})`;
    }
    if (placeholder.hasLinesBefore !== !isLast || placeholder.hasLinesAfter !== !isFirst) {
      return `placeholder for equal run [${run.start}, ${run.end}) has flags ` +
        `before=${placeholder.hasLinesBefore} after=${placeholder.hasLinesAfter}, ` +
        `expected before=${!isLast} after=${!isFirst}`;
    }
  }
  if (hiddenIndex !== hidden.length) {
    return `found ${hidden.length} placeholders but only ${hiddenIndex} hideable equal runs exist`;
  }
  return null;
};

const checkInlineSegmentList = (
  name: string,
  text: string,
  segments: InlineDiffResult[],
): string | null => {
  let cursor = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.start !== cursor) {
      return `${name} inline segment ${i} starts at ${segment.start}, expected ${cursor} (gap or overlap)`;
    }
    if (segment.end <= segment.start) {
      return `${name} inline segment ${i} has non-positive span [${segment.start}, ${segment.end})`;
    }
    cursor = segment.end;
  }
  if (cursor !== text.length) {
    return `${name} inline segments end at ${cursor}, text length is ${text.length}`;
  }
  return null;
};

/** Replay an inline diff: left text + segments must reproduce the right text. */
export const replayInline = (
  textLeft: string,
  textRight: string,
  segmentsLeft: InlineDiffResult[],
  segmentsRight: InlineDiffResult[],
): string => {
  let output = '';
  let i = 0;
  let j = 0;
  while (i < segmentsLeft.length || j < segmentsRight.length) {
    const segmentLeft = segmentsLeft[i];
    const segmentRight = segmentsRight[j];
    if (segmentLeft && segmentLeft.type === 'remove') {
      i++;
      continue;
    }
    if (segmentRight && segmentRight.type === 'add') {
      output += textRight.slice(segmentRight.start, segmentRight.end);
      j++;
      continue;
    }
    if (!segmentLeft || !segmentRight) {
      throw new Error('inline segments are unbalanced');
    }
    output += textLeft.slice(segmentLeft.start, segmentLeft.end);
    i++;
    j++;
  }
  return output;
};

/** Contract 5: inline change segments cover the line and never overlap. */
export const checkInlineSegments = (
  textLeft: string,
  textRight: string,
  segmentsLeft: InlineDiffResult[],
  segmentsRight: InlineDiffResult[],
): string | null => {
  const violationLeft = checkInlineSegmentList('left', textLeft, segmentsLeft);
  if (violationLeft) {
    return violationLeft;
  }
  const violationRight = checkInlineSegmentList('right', textRight, segmentsRight);
  if (violationRight) {
    return violationRight;
  }
  let replayed: string;
  try {
    replayed = replayInline(textLeft, textRight, segmentsLeft, segmentsRight);
  } catch (e) {
    return `inline replay failed: ${(e as Error).message}`;
  }
  if (replayed !== textRight) {
    return `inline replay produced ${JSON.stringify(replayed)}, expected ${JSON.stringify(textRight)}`;
  }
  return null;
};

export interface DiffModelCase {
  sourceLeft: JsonValue;
  sourceRight: JsonValue;
  differOptions: DifferOptions;
  fold: FoldOptions;
}

export interface DiffModelResult {
  left: DiffResult[];
  right: DiffResult[];
  segments: Array<SegmentItem | HiddenUnchangedLinesInfo>;
}

export const runDiffModel = (testCase: DiffModelCase): DiffModelResult => {
  const differ = new Differ(testCase.differOptions);
  const [left, right] = differ.diff(testCase.sourceLeft, testCase.sourceRight);
  const segments = getSegments(left, right, { ...testCase.fold }, false);
  return { left, right, segments };
};

/**
 * Run every contract against one diff. Returns the first violation found,
 * or `null` when the model is consistent.
 */
export const checkDiffModel = (testCase: DiffModelCase): string | null => {
  const { left, right, segments } = runDiffModel(testCase);
  const checks: Array<() => string | null> = [
    () => checkLineNumbers(left, right),
    () => checkContextPaths(left, right),
    () => checkReplay(left, right, testCase.sourceLeft, testCase.sourceRight),
    () => checkSegments(left, right, segments, testCase.fold),
  ];
  for (const check of checks) {
    const violation = check();
    if (violation) {
      return violation;
    }
  }
  for (let i = 0; i < left.length; i++) {
    if (left[i].type === 'modify' && right[i].type === 'modify') {
      for (const mode of ['char', 'word'] as const) {
        const [segmentsLeft, segmentsRight] = getInlineDiff(left[i].text, right[i].text, { mode });
        const violation = checkInlineSegments(left[i].text, right[i].text, segmentsLeft, segmentsRight);
        if (violation) {
          return `row ${i} (${mode} mode): ${violation}`;
        }
      }
    }
  }
  return null;
};
