import type { JsonValue } from './generator';

/**
 * A stable fixture with a long middle context region on both sides, sized so
 * the fold threshold tests have deterministic equal runs regardless of the
 * surrounding serialization.
 */
export const buildLongContextFactory = (): [JsonValue, JsonValue] => {
  const context = Array.from({ length: 40 }, (_, index) => `ctx-${String(index).padStart(2, '0')}`);
  const before: JsonValue = {
    head: 'before-head',
    middle: context,
    tail: 'before-tail',
  };
  const after: JsonValue = {
    head: 'after-head',
    middle: context,
    tail: 'after-tail',
  };
  return [before, after];
};
