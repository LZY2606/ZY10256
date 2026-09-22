import { Random, cloneJson } from './rng';

/**
 * Fixed-seed generator of JSON-representable values and paired mutators.
 *
 * Every produced value survives a `JSON.parse(JSON.stringify(...))` round trip:
 * only JSON types (object, array, string, number, boolean, null) are emitted.
 * Strings are deliberately restricted to words, digits and spaces so that the
 * rendered lines never contain raw structural characters ("{", "}", "[", "]",
 * quotes, colons, commas); the model-level path walker can then classify lines
 * purely by their leading tokens, and replay can stay unambiguous.
 */

export const KEY_POOL = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
const WORD_POOL = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'json', 'diff', 'kit', 'consistency'];

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface GeneratorOptions {
  /** Maximum nesting depth of containers (root is depth 0). */
  maxDepth: number;
  /** Maximum number of elements/keys per container. */
  maxWidth: number;
  /** Rough probability (0..1) that a non-leaf node becomes a container. */
  containerChance: number;
  /** Probability that a generated string is "long" (exercises inline char diff). */
  longStringChance: number;
}

export const DEFAULT_GENERATOR_OPTIONS: GeneratorOptions = {
  maxDepth: 4,
  maxWidth: 6,
  containerChance: 0.55,
  longStringChance: 0.3,
};

export class JsonGenerator {
  private readonly random: Random;
  private readonly options: GeneratorOptions;

  constructor(seed: number, options: Partial<GeneratorOptions> = {}) {
    this.random = new Random(seed);
    this.options = { ...DEFAULT_GENERATOR_OPTIONS, ...options };
  }

  private scalar(): JsonValue {
    switch (this.random.int(0, 4)) {
      case 0:
        return this.random.chance(0.5);
      case 1:
        // Small integers, deliberately allowing duplicates (LCS ties).
        return this.random.int(0, 9);
      case 2:
        return null;
      default:
        return this.random.chance(this.options.longStringChance)
          ? this.longString()
          : this.random.pick(WORD_POOL);
    }
  }

  /**
   * A long string built on a fixed alphabet. Single-character mutations flip
   * exactly one character, so the inline char diff has a unique minimal answer.
   */
  longString(): string {
    const length = this.random.int(24, 48);
    const parts: string[] = [];
    for (let i = 0; i < length; i++) {
      parts.push(this.random.chance(0.8) ? this.random.pick(WORD_POOL)[0] : ' ');
    }
    return parts.join('');
  }

  private value(depth: number): JsonValue {
    if (depth < this.options.maxDepth && this.random.chance(this.options.containerChance)) {
      return this.random.chance(0.5)
        ? this.array(depth)
        : this.object(depth);
    }
    return this.scalar();
  }

  private array(depth: number): JsonValue[] {
    const length = this.random.int(0, this.options.maxWidth);
    const result: JsonValue[] = [];
    for (let i = 0; i < length; i++) {
      result.push(this.value(depth + 1));
    }
    return result;
  }

  private object(depth: number): { [key: string]: JsonValue } {
    const length = this.random.int(0, this.options.maxWidth);
    const result: { [key: string]: JsonValue } = {};
    const pool = [...KEY_POOL];
    for (let i = 0; i < length && pool.length; i++) {
      const keyIndex = this.random.int(0, pool.length - 1);
      const key = pool.splice(keyIndex, 1)[0];
      result[key] = this.value(depth + 1);
    }
    return result;
  }

  /**
   * Generate a root value. Container roots are preferred in the fuzz loop
   * (scalars are covered by the dedicated root-replacement targeted cases).
   */
  root(forceContainer: 'object' | 'array' | 'any' = 'any'): JsonValue {
    if (forceContainer === 'object') {
      return this.object(0);
    }
    if (forceContainer === 'array') {
      return this.array(0);
    }
    return this.random.chance(0.7)
      ? (this.random.chance(0.5) ? this.object(0) : this.array(0))
      : this.scalar();
  }
}

// ---------------------------------------------------------------------------
// Paired mutators
// ---------------------------------------------------------------------------

export type MutationName =
  | 'object-add-key'
  | 'object-remove-key'
  | 'object-change-value'
  | 'array-insert-head'
  | 'array-insert-tail'
  | 'array-insert-middle'
  | 'array-remove-head'
  | 'array-remove-tail'
  | 'array-remove-middle'
  | 'scalar-type-change'
  | 'long-string-one-char'
  | 'deep-subtree-replace';

export const ALL_MUTATIONS: MutationName[] = [
  'object-add-key',
  'object-remove-key',
  'object-change-value',
  'array-insert-head',
  'array-insert-tail',
  'array-insert-middle',
  'array-remove-head',
  'array-remove-tail',
  'array-remove-middle',
  'scalar-type-change',
  'long-string-one-char',
  'deep-subtree-replace',
];

interface ContainerOccurrence {
  path: (string | number)[];
  value: JsonValue;
}

const collectContainers = (
  value: JsonValue,
  path: (string | number)[],
  out: { objects: ContainerOccurrence[]; arrays: ContainerOccurrence[] },
) => {
  if (Array.isArray(value)) {
    out.arrays.push({ path: [...path], value });
    value.forEach((item, index) => collectContainers(item, [...path, index], out));
  } else if (value !== null && typeof value === 'object') {
    out.objects.push({ path: [...path], value });
    for (const key of Object.keys(value)) {
      collectContainers(value[key], [...path, key], out);
    }
  }
};

const findContainers = (value: JsonValue) => {
  const out: { objects: ContainerOccurrence[]; arrays: ContainerOccurrence[] } = { objects: [], arrays: [] };
  collectContainers(value, [], out);
  return out;
};

const getAt = (root: JsonValue, path: (string | number)[]): JsonValue => {
  let current: JsonValue = root;
  for (const segment of path) {
    current = (current as any)[segment];
  }
  return current;
};

const setAt = (root: JsonValue, path: (string | number)[], value: JsonValue): boolean => {
  let current: any = root;
  for (let i = 0; i < path.length - 1; i++) {
    current = current?.[path[i]];
    if (current === null || typeof current !== 'object') {
      return false;
    }
  }
  if (current === null || typeof current !== 'object') {
    return false;
  }
  current[path[path.length - 1]] = value;
  return true;
};

/**
 * Replace a scalar with one of a *different* JSON type (number -> string,
 * string -> boolean, ...), exercising the differ's type-mismatch branch.
 */
const scalarOfDifferentType = (current: JsonValue, random: Random): JsonValue => {
  const currentType = current === null ? 'null' : typeof current;
  const candidates: JsonValue[] = [0, 1, 7, 'alpha', 'bravo', true, false, null];
  const usable = candidates.filter(candidate => {
    const candidateType = candidate === null ? 'null' : typeof candidate;
    return candidateType !== currentType || candidate !== current;
  }).filter(candidate => {
    const candidateType = candidate === null ? 'null' : typeof candidate;
    return candidateType !== currentType;
  });
  return random.pick(usable.length ? usable : candidates);
};

/**
 * Apply one named mutation to a deep clone of `before`. Returns `null` when the
 * current shape cannot host this mutation (e.g. removing a key from a value
 * with no objects); the caller retries with another action.
 */
export const applyMutation = (
  before: JsonValue,
  name: MutationName,
  random: Random,
): { after: JsonValue; path: (string | number)[] } | null => {
  const after = cloneJson(before);
  const { objects, arrays } = findContainers(after);

  switch (name) {
    case 'object-add-key': {
      if (!objects.length) {
        return null;
      }
      const target = random.pick(objects);
      const freeKeys = KEY_POOL.filter(key => !(key in (target.value as Record<string, JsonValue>)));
      if (!freeKeys.length) {
        return null;
      }
      const key = random.pick(freeKeys);
      (target.value as Record<string, JsonValue>)[key] = new JsonGenerator(random.int(1, 1e9), {
        maxDepth: 2,
        maxWidth: 3,
      }).root('any');
      return { after, path: [...target.path, key] };
    }
    case 'object-remove-key': {
      const removable = objects
        .flatMap(occurrence => Object.keys(occurrence.value as Record<string, JsonValue>)
          .map(key => ({ occurrence, key })));
      if (!removable.length) {
        return null;
      }
      const choice = random.pick(removable);
      delete (choice.occurrence.value as Record<string, JsonValue>)[choice.key];
      return { after, path: [...choice.occurrence.path, choice.key] };
    }
    case 'object-change-value': {
      const changeable = objects
        .flatMap(occurrence => Object.entries(occurrence.value as Record<string, JsonValue>)
          .filter(([, value]) => value !== null && typeof value !== 'object')
          .map(([key, value]) => ({ occurrence, key, value })));
      if (!changeable.length) {
        return null;
      }
      const choice = random.pick(changeable);
      (choice.occurrence.value as Record<string, JsonValue>)[choice.key] =
        scalarOfDifferentType(choice.value, random);
      return { after, path: [...choice.occurrence.path, choice.key] };
    }
    case 'array-insert-head':
    case 'array-insert-tail':
    case 'array-insert-middle': {
      if (!arrays.length) {
        return null;
      }
      const target = random.pick(arrays).value as JsonValue[];
      const inserted: JsonValue = new JsonGenerator(random.int(1, 1e9), { maxDepth: 2, maxWidth: 3 }).root('any');
      const index = name === 'array-insert-head'
        ? 0
        : name === 'array-insert-tail'
          ? target.length
          : random.int(0, target.length);
      target.splice(index, 0, inserted);
      return { after, path: [] };
    }
    case 'array-remove-head':
    case 'array-remove-tail':
    case 'array-remove-middle': {
      const nonEmpty = arrays.filter(occurrence => (occurrence.value as JsonValue[]).length > 0);
      if (!nonEmpty.length) {
        return null;
      }
      const occurrence = random.pick(nonEmpty);
      const target = occurrence.value as JsonValue[];
      const index = name === 'array-remove-head'
        ? 0
        : name === 'array-remove-tail'
          ? target.length - 1
          : random.int(0, target.length - 1);
      target.splice(index, 1);
      return { after, path: occurrence.path };
    }
    case 'scalar-type-change': {
      const scalars: { path: (string | number)[]; value: JsonValue }[] = [];
      const walk = (value: JsonValue, path: (string | number)[]) => {
        if (value !== null && typeof value !== 'object') {
          scalars.push({ path, value });
        } else if (Array.isArray(value)) {
          value.forEach((item, index) => walk(item, [...path, index]));
        } else if (typeof value === 'object' && value !== null) {
          for (const key of Object.keys(value)) {
            walk(value[key], [...path, key]);
          }
        }
      };
      walk(after, []);
      if (!scalars.length) {
        return null;
      }
      const choice = random.pick(scalars);
      if (!setAt(after, choice.path, scalarOfDifferentType(getAt(after, choice.path), random))) {
        return null;
      }
      return { after, path: choice.path };
    }
    case 'long-string-one-char': {
      const strings: { path: (string | number)[]; value: string }[] = [];
      const walk = (value: JsonValue, path: (string | number)[]) => {
        if (typeof value === 'string') {
          strings.push({ path, value });
        } else if (Array.isArray(value)) {
          value.forEach((item, index) => walk(item, [...path, index]));
        } else if (typeof value === 'object' && value !== null) {
          for (const key of Object.keys(value)) {
            walk(value[key], [...path, key]);
          }
        }
      };
      walk(after, []);
      // Prefer an already-long string; any non-empty string works too.
      const longEnough = strings.filter(entry => entry.value.length >= 8);
      if (!longEnough.length) {
        return null;
      }
      const choice = random.pick(longEnough);
      const index = random.int(0, choice.value.length - 1);
      const replacement = random.pick(['X', 'Y', 'Z', '9']);
      const mutated = `${choice.value.slice(0, index)}${replacement}${choice.value.slice(index + 1)}`;
      if (!setAt(after, choice.path, mutated)) {
        return null;
      }
      return { after, path: choice.path };
    }
    case 'deep-subtree-replace': {
      // Replace a container (or the root) with a freshly generated subtree.
      const candidates: ContainerOccurrence[] = [
        { path: [], value: after },
        ...objects,
        ...arrays,
      ];
      const choice = random.pick(candidates);
      const replacement = new JsonGenerator(random.int(1, 1e9), {
        maxDepth: 3,
        maxWidth: 5,
      }).root(Array.isArray(choice.value) ? 'array' : typeof choice.value === 'object' && choice.value !== null ? 'object' : 'any');
      if (!choice.path.length) {
        return { after: replacement, path: [] };
      }
      if (!setAt(after, choice.path, replacement)) {
        return null;
      }
      return { after, path: choice.path };
    }
  }
};

/**
 * Build a paired `(before, after)` value by applying 1..`maxActions` randomly
 * chosen mutations in sequence. The returned mutation names make failures
 * reproducible without relying on property-enumeration order anywhere.
 */
export const mutatePair = (
  before: JsonValue,
  random: Random,
  maxActions = 3,
): { after: JsonValue; actions: MutationName[] } => {
  const actionCount = random.int(1, maxActions);
  let current = cloneJson(before);
  const actions: MutationName[] = [];
  let attempts = 0;
  while (actions.length < actionCount && attempts < actionCount * 12) {
    attempts++;
    const name = random.pick(ALL_MUTATIONS);
    const result = applyMutation(current, name, random);
    if (result) {
      current = result.after;
      actions.push(name);
    }
  }
  if (!actions.length) {
    // Degenerate input: replace the root outright so every pair still changes.
    const result = applyMutation(current, 'deep-subtree-replace', random);
    current = result!.after;
    actions.push('deep-subtree-replace');
  }
  return { after: current, actions };
};
