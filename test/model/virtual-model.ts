import findVisibleLines from '../../src/utils/find-visible-lines';
import calculatePlaceholderHeight from '../../src/utils/calculate-placeholder-height';
import getSegments from '../../src/utils/get-segments';
import { isExpandLine } from '../../src/utils/segment-util';
import type { AnySegment, DiffPair } from './contract';
import type { HideUnchangedLinesOptions } from '../../src/viewer';

/**
 * Headless mirror of the Viewer virtual-list math (see `src/viewer.tsx`).
 *
 * The Viewer computes accumulated segment tops twice: once for rendering and
 * once inside the windowed binary search. These tests assert the two models
 * agree at every pixel boundary of a long, folded diff — the historical bug
 * was that segment height used an inclusive `end` while the rest of the layout
 * treated `[start, end)` as half-open, shifting line numbers and fold ranges
 * by one around context boundaries.
 */

export interface VirtualLayout {
  segments: AnySegment[];
  accTops: number[];
  totalHeight: number;
  itemHeight: number;
  expandLineHeight: number;
}

export const buildLayout = (
  pair: DiffPair,
  fold: HideUnchangedLinesOptions,
  itemHeight = 18,
  expandLineHeight = 26,
): VirtualLayout => {
  const segments = getSegments(pair[0], pair[1], fold, false) as AnySegment[];
  const accTops: number[] = [];
  let acc = 0;
  for (const segment of segments) {
    accTops.push(acc);
    acc += isExpandLine(segment)
      ? expandLineHeight
      : itemHeight * (segment.end - segment.start);
  }
  return { segments, accTops, totalHeight: acc, itemHeight, expandLineHeight };
};

export interface VirtualWindowResult {
  topHeight: number;
  bottomHeight: number;
  renderedRows: Array<{ segmentIndex: number; rows: number[] }>;
}

const windowedRender = (layout: VirtualLayout, viewportTop: number, viewportBottom: number): VirtualWindowResult => {
  const { segments, accTops, totalHeight, itemHeight, expandLineHeight } = layout;
  const [startSegment, startLine, endSegment, endLine] = findVisibleLines(
    segments,
    accTops,
    viewportTop,
    viewportBottom,
    itemHeight,
    expandLineHeight,
  );
  const [topHeight, bottomHeight] = calculatePlaceholderHeight(
    segments,
    accTops,
    startSegment,
    startLine,
    endSegment,
    endLine,
    itemHeight,
    expandLineHeight,
    totalHeight,
  );

  const renderedRows: Array<{ segmentIndex: number; rows: number[] }> = [];
  for (let segmentIndex = startSegment; segmentIndex <= endSegment; segmentIndex++) {
    const segment = segments[segmentIndex];
    if (isExpandLine(segment)) {
      renderedRows.push({ segmentIndex, rows: [] });
      continue;
    }
    const from = Math.max(segment.start, startLine);
    const until = Math.min(segment.end, endLine);
    const rows: number[] = [];
    for (let row = from; row < until; row++) {
      rows.push(row);
    }
    renderedRows.push({ segmentIndex, rows });
  }
  return { topHeight, bottomHeight, renderedRows };
};

const renderedPixelHeight = (layout: VirtualLayout, window: VirtualWindowResult): number => {
  const { segments, itemHeight, expandLineHeight } = layout;
  return window.renderedRows.reduce((sum, piece) => {
    const segment = segments[piece.segmentIndex];
    return sum + (isExpandLine(segment) ? expandLineHeight : piece.rows.length * itemHeight);
  }, 0);
};

/**
 * Sweep every viewport position (and several viewport heights) and assert:
 * 1. spacers + rendered content exactly fill the total height (no gap/overlap);
 * 2. every rendered row really intersects the viewport;
 * 3. every model row or expand-line intersecting the viewport is rendered
 *    (start/end lines are inclusive of boundary-straddling items, mirroring the
 *    Viewer's floor/ceil math).
 */
export const assertVirtualWindowConsistency = (pair: DiffPair, fold: HideUnchangedLinesOptions, contextLabel: string) => {
  const layout = buildLayout(pair, fold);
  if (!layout.totalHeight) {
    throw new Error(`${contextLabel}: virtual layout has zero total height`);
  }
  const viewportHeights = [layout.itemHeight, layout.itemHeight * 3, layout.expandLineHeight + 2];

  for (const viewportHeight of viewportHeights) {
    for (let scrollTop = 0; scrollTop <= layout.totalHeight + layout.itemHeight; scrollTop++) {
      const viewportTop = scrollTop;
      const viewportBottom = scrollTop + viewportHeight;
      const window = windowedRender(layout, viewportTop, viewportBottom);
      const filledHeight = window.topHeight + renderedPixelHeight(layout, window) + window.bottomHeight;
      if (filledHeight !== layout.totalHeight) {
        throw new Error(
          `${contextLabel}: spacers+rendered=${filledHeight} != total=${layout.totalHeight} ` +
          `at top=${viewportTop} bottom=${viewportBottom}`,
        );
      }

      // Ground truth: which physical units (rows or expand lines) intersect.
      const expectedSegments = new Set<number>();
      const expectedRows = new Set<number>();
      layout.segments.forEach((segment, segmentIndex) => {
        const top = layout.accTops[segmentIndex];
        const height = isExpandLine(segment)
          ? layout.expandLineHeight
          : layout.itemHeight * (segment.end - segment.start);
        if (top < viewportBottom && top + height > viewportTop) {
          expectedSegments.add(segmentIndex);
        }
        if (!isExpandLine(segment)) {
          for (let row = segment.start; row < segment.end; row++) {
            const rowTop = top + (row - segment.start) * layout.itemHeight;
            if (rowTop < viewportBottom && rowTop + layout.itemHeight > viewportTop) {
              expectedRows.add(row);
            }
          }
        }
      });

      const renderedSegments = new Set(window.renderedRows.map(piece => piece.segmentIndex));
      for (const segmentIndex of expectedSegments) {
        if (!renderedSegments.has(segmentIndex)) {
          throw new Error(
            `${contextLabel}: segment ${segmentIndex} intersects viewport [${viewportTop}, ${viewportBottom}) but is not rendered`,
          );
        }
      }
      const renderedRowSet = new Set(window.renderedRows.flatMap(piece => piece.rows));
      for (const row of expectedRows) {
        if (!renderedRowSet.has(row)) {
          throw new Error(
            `${contextLabel}: row ${row} intersects viewport [${viewportTop}, ${viewportBottom}) but is not rendered`,
          );
        }
      }
    }
  }
};
