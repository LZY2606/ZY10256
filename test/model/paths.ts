import type { DiffResult } from '../../src/differ';

/**
 * Model-only structural walker for *aligned* diff columns.
 *
 * The two columns are rendered as one physical row per index; a side with no
 * content contributes an `equal` blank line. Insertions, deletions and LCS
 * alignments mean array ordinals legitimately differ across sides, so the
 * invariant is expressed structurally rather than by ordinal equality:
 *
 * - every rendered column is a balanced nesting of `{ }` / `[ ]`;
 * - at a row where BOTH sides render an opener, the containers have the same
 *   kind (object/object or array/array), and when the opener is a keyed object
 *   member, the keys are identical;
 * - at a row where BOTH sides render a keyed member line (`"key": value`),
 *   the keys are identical;
 * - an `equal/equal` row renders the same text on both sides.
 *
 * That is exactly what the Viewer relies on to paint the row on one shared
 * line, and it holds for every supported alignment (`normal`, `lcs`,
 * `unorder-*`, `compare-key`) without assuming property-enumeration order.
 */

const KEY_PREFIX = /^"((?:[^"\\]|\\.)*)":/;

export type LineKind =
| { kind: 'object-open'; key?: string }
| { kind: 'array-open'; key?: string }
| { kind: 'object-close' }
| { kind: 'array-close' }
| { kind: 'keyed-value'; key: string }
| { kind: 'bare-value' }
| { kind: 'blank' };

const unescapeKey = (raw: string): string => JSON.parse(`"${raw}"`);

export const classifyLine = (line: DiffResult): LineKind => {
  const { text } = line;
  if (text === '') {
    return { kind: 'blank' };
  }
  const keyed = text.match(KEY_PREFIX);
  if (/^\{$/.test(text)) {
    return { kind: 'object-open' };
  }
  if (/^\[$/.test(text)) {
    return { kind: 'array-open' };
  }
  if (/^\}$/.test(text)) {
    return { kind: 'object-close' };
  }
  if (/^\]$/.test(text)) {
    return { kind: 'array-close' };
  }
  if (/": \{$/.test(text) && keyed) {
    return { kind: 'object-open', key: unescapeKey(keyed[1]) };
  }
  if (/": \[$/.test(text) && keyed) {
    return { kind: 'array-open', key: unescapeKey(keyed[1]) };
  }
  if (keyed) {
    return { kind: 'keyed-value', key: unescapeKey(keyed[1]) };
  }
  return { kind: 'bare-value' };
};

const OPENERS = new Set(['object-open', 'array-open']);
const CLOSERS = new Set(['object-close', 'array-close']);

/** Verify each column is balanced (no lost brackets) and return row kinds. */
const checkBalance = (lines: DiffResult[], sideName: string, ctxLabel: string): LineKind[] => {
  const stack: string[] = [];
  const kinds: LineKind[] = [];
  lines.forEach((line, index) => {
    const kind = classifyLine(line);
    kinds.push(kind);
    if (OPENERS.has(kind.kind)) {
      stack.push(kind.kind === 'object-open' ? 'object' : 'array');
    } else if (CLOSERS.has(kind.kind)) {
      const expected = kind.kind === 'object-close' ? 'object' : 'array';
      if (stack.pop() !== expected) {
        throw new Error(`${ctxLabel}: ${sideName} row ${index}: unmatched ${kind.kind}`);
      }
    }
  });
  if (stack.length) {
    throw new Error(`${ctxLabel}: ${sideName} column ends with ${stack.length} unclosed frame(s)`);
  }
  return kinds;
};

/**
 * Assert the cross-column alignment contract. Throws with row-index context on
 * the first violation.
 */
export const assertAlignedStructure = (
  left: DiffResult[],
  right: DiffResult[],
  ctxLabel: string,
): void => {
  if (left.length !== right.length) {
    throw new Error(`${ctxLabel}: column length mismatch ${left.length} vs ${right.length}`);
  }
  const kindsLeft = checkBalance(left, 'left', ctxLabel);
  const kindsRight = checkBalance(right, 'right', ctxLabel);

  for (let index = 0; index < left.length; index++) {
    const leftKind = kindsLeft[index];
    const rightKind = kindsRight[index];
    const bothRender = leftKind.kind !== 'blank' && rightKind.kind !== 'blank';
    if (!bothRender) {
      continue;
    }

    if (
      (leftKind.kind === 'object-open' || leftKind.kind === 'array-open') &&
      (rightKind.kind === 'object-open' || rightKind.kind === 'array-open')
    ) {
      // A modify/modify opener pair may be a type replacement (array ->
      // object); shared framing is only required for equal rows.
      if (left[index].type !== 'equal' || right[index].type !== 'equal') {
        continue;
      }
      if (leftKind.kind !== rightKind.kind) {
        throw new Error(`${ctxLabel}: row ${index}: opener kinds diverge (${leftKind.kind} vs ${rightKind.kind})`);
      }
      const leftKey = 'key' in leftKind ? leftKind.key : undefined;
      const rightKey = 'key' in rightKind ? rightKind.key : undefined;
      if ((leftKey !== undefined || rightKey !== undefined) && leftKey !== rightKey) {
        throw new Error(`${ctxLabel}: row ${index}: aligned openers use different keys ("${leftKey}" vs "${rightKey}")`);
      }
      continue;
    }

    if (leftKind.kind === 'keyed-value' && rightKind.kind === 'keyed-value') {
      if (left[index].type !== 'equal' || right[index].type !== 'equal') {
        continue;
      }
      if (leftKind.key !== rightKind.key) {
        throw new Error(`${ctxLabel}: row ${index}: common context keys diverge ("${leftKind.key}" vs "${rightKind.key}")`);
      }
    }

    if (left[index].type === 'equal' && right[index].type === 'equal' && left[index].text !== right[index].text) {
      throw new Error(
        `${ctxLabel}: row ${index}: equal rows render different text (${JSON.stringify(left[index].text)} vs ${JSON.stringify(right[index].text)})`,
      );
    }
    if (left[index].type === 'equal' && right[index].type === 'equal' && left[index].level !== right[index].level) {
      throw new Error(`${ctxLabel}: row ${index}: equal rows sit at different indentation levels`);
    }
  }
};
