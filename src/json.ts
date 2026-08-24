export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/u;

function unsupported(path: string, detail: string): never {
  throw new TypeError(`JSON boundary value at ${path} ${detail}`);
}

function ownDataValue(object: object, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    return unsupported(path, 'must be an enumerable data property');
  }
  return descriptor.value;
}

function cloneJson(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return unsupported(path, 'must be a finite number');
    return value;
  }
  if (
    typeof value === 'undefined' ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    typeof value === 'bigint'
  ) {
    return unsupported(path, `cannot contain ${typeof value}`);
  }
  if (typeof value !== 'object') return unsupported(path, `cannot contain ${typeof value}`);
  if (ancestors.has(value)) return unsupported(path, 'must not be cyclic');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') return unsupported(path, 'cannot contain symbol keys');
        if (key !== 'length' && (!ARRAY_INDEX.test(key) || Number(key) >= value.length)) {
          return unsupported(`${path}.${key}`, 'is not a JSON array index');
        }
      }
      const output: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          return unsupported(`${path}[${index}]`, 'cannot be a sparse array slot');
        }
        output.push(cloneJson(ownDataValue(value, String(index), `${path}[${index}]`), `${path}[${index}]`, ancestors));
      }
      return Object.freeze(output);
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      return unsupported(path, 'must be a plain object or array');
    }

    const output: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') return unsupported(path, 'cannot contain symbol keys');
      const item = ownDataValue(value, key, `${path}.${key}`);
      Object.defineProperty(output, key, {
        value: cloneJson(item, `${path}.${key}`, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return Object.freeze(output);
  } finally {
    ancestors.delete(value);
  }
}

/** Clone a strict JSON value and recursively freeze the detached result. */
export function normalizeJson(value: unknown): JsonValue {
  return cloneJson(value, '$', new Set());
}
