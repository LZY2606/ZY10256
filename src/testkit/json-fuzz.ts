import type { Rng } from './seeded-random';
import { pickInt, pickOne } from './seeded-random';

/**
 * Keys are drawn from a small, JSON-safe pool (no quotes / backslashes) on purpose:
 * - a small pool makes key collisions likely, so object diffs exercise
 *   add / remove / modify on the same run of keys;
 * - the pool only contains characters that keep the differ's textual line
 *   output parseable by `JSON.parse`, which the patch interpreter relies on.
 */
const KEY_POOL = [
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta',
  'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu',
] as const;

const WORD_POOL = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur',
  'adipiscing', 'elit', 'sed', 'do', 'eiusmod', 'tempor',
] as const;

const CHAR_POOL = 'abcdefghijklmnopqrstuvwxyz0123456789';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const randomString = (rng: Rng, maxWords: number): string => {
  const words = pickInt(rng, 1, maxWords);
  const parts: string[] = [];
  for (let i = 0; i < words; i++) {
    parts.push(pickOne(rng, WORD_POOL));
  }
  return parts.join(' ');
};

export const randomLongString = (rng: Rng): string => randomString(rng, 24);

const randomScalar = (rng: Rng): JsonValue => {
  switch (pickInt(rng, 0, 5)) {
    case 0: return null;
    case 1: return rng() < 0.5;
    case 2: return pickInt(rng, -1000, 1000);
    case 3: return pickInt(rng, -100, 100) / 4;
    case 4: return randomString(rng, 3);
    default: return randomLongString(rng);
  }
};

export const generateJson = (rng: Rng, maxDepth = 4): JsonValue => {
  if (maxDepth <= 0) {
    return randomScalar(rng);
  }
  const kind = pickInt(rng, 0, 9);
  if (kind < 4) {
    return randomScalar(rng);
  }
  if (kind < 7) {
    const length = pickInt(rng, 0, 8);
    const arr: JsonValue[] = [];
    for (let i = 0; i < length; i++) {
      arr.push(generateJson(rng, maxDepth - 1));
    }
    return arr;
  }
  const count = pickInt(rng, 0, 8);
  const obj: { [key: string]: JsonValue } = {};
  const used = new Set<string>();
  for (let i = 0; i < count; i++) {
    let key = pickOne(rng, KEY_POOL);
    while (used.has(key)) {
      key = pickOne(rng, KEY_POOL);
    }
    used.add(key);
    obj[key] = generateJson(rng, maxDepth - 1);
  }
  return obj;
};

const isObject = (v: JsonValue): v is { [key: string]: JsonValue } => {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
};

/** Collect all [parent, key] slots so a mutation can target any depth. */
const collectSlots = (value: JsonValue): Array<{ parent: JsonValue; key: string | number }> => {
  const slots: Array<{ parent: JsonValue; key: string | number }> = [];
  const walk = (node: JsonValue) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        slots.push({ parent: node, key: index });
        walk(item);
      });
    } else if (isObject(node)) {
      for (const key of Object.keys(node)) {
        slots.push({ parent: node, key });
        walk(node[key]);
      }
    }
  };
  walk(value);
  return slots;
};

const scalarTypeShift = (rng: Rng, value: JsonValue): JsonValue => {
  if (typeof value === 'string') {
    return pickInt(rng, -100, 100);
  }
  if (typeof value === 'number') {
    return rng() < 0.5 ? String(value) : value > 0;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : null;
  }
  return pickOne(rng, [0, '', false] as const);
};

const mutateStringOneChar = (rng: Rng, value: string): string => {
  if (!value.length) {
    return pickOne(rng, CHAR_POOL.split(''));
  }
  const index = pickInt(rng, 0, value.length - 1);
  let next = pickOne(rng, CHAR_POOL.split(''));
  while (next === value[index]) {
    next = pickOne(rng, CHAR_POOL.split(''));
  }
  return value.slice(0, index) + next + value.slice(index + 1);
};

const mutateObject = (rng: Rng, obj: { [key: string]: JsonValue }) => {
  const keys = Object.keys(obj);
  const action = pickInt(rng, 0, 2);
  if (action === 0 || !keys.length) {
    const fresh = KEY_POOL.filter(k => !(k in obj));
    if (fresh.length) {
      obj[pickOne(rng, fresh)] = generateJson(rng, 2);
    }
  } else if (action === 1) {
    delete obj[pickOne(rng, keys)];
  } else {
    obj[pickOne(rng, keys)] = generateJson(rng, 2);
  }
};

const mutateArray = (rng: Rng, arr: JsonValue[]) => {
  const action = pickInt(rng, 0, 5);
  if (action <= 2 || !arr.length) {
    const value = generateJson(rng, 2);
    if (action === 0) {
      arr.unshift(value);
    } else if (action === 1) {
      arr.push(value);
    } else {
      arr.splice(pickInt(rng, 0, arr.length), 0, value);
    }
  } else if (action === 3) {
    arr.shift();
  } else if (action === 4) {
    arr.pop();
  } else {
    arr.splice(pickInt(rng, 0, arr.length - 1), 1);
  }
};

/**
 * Apply one random mutation in place. Actions cover: object key add / remove /
 * modify, array insert / delete at head / tail / middle, scalar type change,
 * single-character change inside (long) strings and deep subtree replacement.
 */
export const mutateOnce = (rng: Rng, root: JsonValue): void => {
  const slots = collectSlots(root);
  if (!slots.length) {
    return;
  }
  const slot = pickOne(rng, slots);
  const current: JsonValue = Array.isArray(slot.parent)
    ? slot.parent[slot.key as number]
    : (slot.parent as { [key: string]: JsonValue })[slot.key as string];
  const action = pickInt(rng, 0, 6);
  if (action === 0 && isObject(current)) {
    mutateObject(rng, current);
    return;
  }
  if (action === 1 && Array.isArray(current)) {
    mutateArray(rng, current);
    return;
  }
  if (action === 2 && typeof current === 'string') {
    const next = mutateStringOneChar(rng, current);
    if (Array.isArray(slot.parent)) {
      slot.parent[slot.key as number] = next;
    } else {
      (slot.parent as { [key: string]: JsonValue })[slot.key as string] = next;
    }
    return;
  }
  if (action === 3 && (current === null || ['string', 'number', 'boolean'].includes(typeof current))) {
    const next = scalarTypeShift(rng, current);
    if (Array.isArray(slot.parent)) {
      slot.parent[slot.key as number] = next;
    } else {
      (slot.parent as { [key: string]: JsonValue })[slot.key as string] = next;
    }
    return;
  }
  // Deep subtree replacement (also the fallback for unmatched actions above).
  const next = generateJson(rng, 2);
  if (Array.isArray(slot.parent)) {
    slot.parent[slot.key as number] = next;
  } else {
    (slot.parent as { [key: string]: JsonValue })[slot.key as string] = next;
  }
};

export const deepClone = (value: JsonValue): JsonValue => JSON.parse(JSON.stringify(value));

/**
 * Produce a mutated copy of `value`. `mutations` controls how many single
 * mutations are applied; a root-level replacement is possible but not forced.
 */
export const mutateJson = (rng: Rng, value: JsonValue, mutations: number): JsonValue => {
  let result = deepClone(value);
  for (let i = 0; i < mutations; i++) {
    const slots = collectSlots(result);
    if (!slots.length || rng() < 0.1) {
      // Replace the whole root value (covers "root value replacement").
      result = generateJson(rng, 3);
    } else {
      mutateOnce(rng, result);
    }
  }
  return result;
};
