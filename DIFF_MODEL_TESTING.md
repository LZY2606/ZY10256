# Diff-Model Consistency Contract

This document describes the model-level invariants enforced by the test suite
under [`test/model`](./test/model). The tests deliberately assert against the
`Differ` output data (`DiffResult[]` rows, fold `segments`, inline-diff
intervals) rather than rendered DOM snapshots: snapshots hide alignment and
ranging bugs behind visual tolerance, while the model contract fails exactly
at the row/offset that is wrong.

## Model Under Test

`new Differ(options).diff(before, after)` returns two equally long columns:

- each physical row is a `[leftLine, rightLine]` pair;
- a side with no content on a row contributes `{ type: 'equal', text: '' }`,
  which is never assigned a visible line number;
- line types are `equal`, `add`, `remove`, `modify`;
- `lineNumber` is assigned per side, counting visible (`text !== ''`) rows
  from `1`;
- `getSegments(linesLeft, linesRight, hideOptions, jsonsAreEqual)` partitions
  the aligned row range into regular segments and "expand" placeholders;
- `getInlineDiff(leftText, rightText, mode)` produces per-side intervals of
  unchanged (no `type`) and `add` / `remove` character (or word) ranges.

## Enforced Invariants

1. **Column shape.** Both columns have the same length; every line has a known
   type and non-negative integer level.
2. **Continuous visible line numbers.** On each side the visible rows are
   numbered `1..N` with no gap, duplicate or reordering; blank alignment rows
   never carry a number.
3. **Aligned common context.** Brackets balance on each side; at rows rendered
   on both sides, openers agree in kind (`{`/`[`) and object-member key, and
   `equal/equal` rows render identical text at the same level. Array ordinals
   are *not* required to match across sides, because LCS and the array methods
   intentionally align different indices; native property-enumeration order is
   never treated as canonical — key order follows `preserveKeyOrder`
   (default: sorted).
4. **Inline segments cover without overlap.** For every `modify` pair with
   text on both sides, intervals are within `[0, length]`, sorted, disjoint,
   leave no gap, and the untyped ("shared") intervals spell the same string on
   both sides; each side's intervals concatenate back to its full text, so no
   character is dropped or duplicated.
5. **Fold partition and placeholder expansion.** `getSegments` covers the
   half-open range `[0, N)` exactly; a placeholder hides only genuinely equal
   rows. Replacing every expand placeholder by its hidden row range restores
   the full unfolded row sequence in order (folding loses no data).
6. **Virtual-window geometry.** The binary search in `findVisibleLines` and
   the spacers computed by `calculatePlaceholderHeight` use the same half-open
   heights as the Viewer's accumulated layout. The tests sweep every scroll
   position and assert spacers + rendered units exactly fill the total height
   and that every unit intersecting the viewport is rendered.
7. **Patch replay.** An in-test interpreter renders each visible side into a
   pretty JSON document (indentation + `comma` flags) and `JSON.parse`s it.
   The parsed left/right documents deep-equal the diff inputs (for the
   `unorder-*` and `compare-key` methods, replay is compared against the
   documented normalized/order-agnostic inputs).
8. **Minimum LCS edit count under ties.** For scalar arrays with repeated
   values the library may choose any optimal LCS alignment; tests assert only
   replayability and that the number of edits equals
   `|A| + |B| - 2 * LCS(A, B)` (a `modify` row counts as one removal plus one
   insertion).

## Fuzz Harness

- `test/model/rng.ts` — deterministic mulberry32 PRNG; no clock, network, file
  system traversal order or `Math.random()` dependency.
- `test/model/generator.ts` — JSON-only value generator (object/array/string/
  number/boolean/null) and paired mutators covering object key add/remove/
  change, array insert/remove at head/tail/middle, scalar type changes,
  single-character long-string edits and deep subtree replacement.
- `test/model/shrink.ts` — deterministic delta debugging; on failure the
  reported inputs are independently reduced while the same contract keeps
  failing. The assertion message also prints both rendered columns, the
  offending row and the differ options.

Directed cases cover zero-context diffs, runs whose length is exactly one
above/equal to the fold threshold, two adjacent fold zones, root value
replacement (object ↔ array ↔ scalar/null) and empty containers. Negative
tests deliberately corrupt right-side line numbers, placeholder-covered row
types and inline endpoints to prove each guard fails with readable context.

## Complexity

| Configuration / component | Time | Notes |
| --- | --- | --- |
| `arrayDiffMethod: 'normal'` | `O(n)` in total element count | positional comparison |
| `arrayDiffMethod: 'lcs'` | `O(n · m)` per nested array | classic LCS table |
| `unorder-normal` / `unorder-lcs` | sorting + the method above | inner arrays are recursively sorted first |
| `compare-key` | `O(n + m)` per eligible array | falls back to `normal` when a compare key is missing |
| object member diff | `O(k log k)` + value diffs | key sort; skipped with `preserveKeyOrder` |
| inline char diff | Myers O(n + d · n)-class | used only for rendered `modify` lines |
| fold segmentation | `O(rows)` | one linear scan |
| virtual window lookup | `O(log segments)` | binary search + spacer arithmetic |

## Compatibility Trade-Offs

- Default key order is lexical to make output deterministic across engines;
  `preserveKeyOrder: 'before' | 'after'` opts into input order.
- `normal` array diff is linear but treats an index shift at the same position
  as modifications; `lcs` is quadratic but recognizes moved elements.
- `unorder-*` is defined against *sorted* inputs; replay tests therefore
  compare against the normalized values, not raw input order.
- `compare-key` is order-agnostic: matched objects render alongside their
  left-side peers, so replay is compared after ordering by the configured key.
- Virtual scrolling assumes fixed row heights (`itemHeight`,
  `expandLineHeight`); the model tests do not require a DOM or React renderer.
- Everything runs locally; no external service, network or real clock is used
  by the test suite.

## Running

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test -- --runInBand
```
