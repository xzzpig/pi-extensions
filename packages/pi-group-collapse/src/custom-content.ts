import { types } from "node:util";

type Field = readonly [key: string, flags: number, value: CustomSnapshot];
export type CustomSnapshot =
  | string
  | number
  | boolean
  | null
  | undefined
  | {
      readonly identity: object;
      readonly fields: readonly Field[];
      readonly shape: "array" | "plain" | "null";
      readonly extensible: boolean;
    };

const MAX_VERIFIABLE_FIELDS = 64;
export const opaqueCustomField = Symbol("opaque custom message field");

/** Read an own data property without executing a getter or proxy trap. */
export function customField(
  record: { constructor: Function },
  key: string,
): { value: unknown } {
  if (types.isProxy(record)) return { value: opaqueCustomField };
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor)
    return {
      value: "value" in descriptor ? descriptor.value : opaqueCustomField,
    };
  // Do not try an inherited getter on an unfamiliar message shape.
  const prototype = Object.getPrototypeOf(record);
  return {
    value:
      prototype === Object.prototype || prototype === null
        ? undefined
        : opaqueCustomField,
  };
}

/** Capture only small data graphs. Large or opaque payloads have no timing proof. */
export function snapshotCustomMessage(
  message: unknown,
): { value: CustomSnapshot } | undefined {
  let remaining = MAX_VERIFIABLE_FIELDS;
  const visiting = new Set<object>();
  function capture(value: unknown, depth: number): CustomSnapshot {
    if (--remaining < 0 || depth > 24) throw unsupported;
    if (
      value == null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      return value;
    // Reject even revoked proxies without performing a reflective operation
    // on them; a timing check must not run extension traps during repaint.
    if (
      typeof value !== "object" ||
      types.isProxy(value) ||
      visiting.has(value)
    )
      throw unsupported;
    const prototype = Object.getPrototypeOf(value);
    let shape: "array" | "plain" | "null";
    if (Array.isArray(value) && prototype === Array.prototype) {
      // The length of a non-proxy array is an own data property. Reject a
      // large array in constant time, before enumerating its indices.
      if (value.length > remaining) throw unsupported;
      shape = "array";
    } else if (prototype === Object.prototype) shape = "plain";
    else if (prototype === null) shape = "null";
    else throw unsupported;
    const keys = Reflect.ownKeys(value);
    if (keys.length > remaining) throw unsupported;
    visiting.add(value);
    const fields: Field[] = [];
    for (const key of keys) {
      if (typeof key !== "string") throw unsupported;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw unsupported;
      const flags =
        Number(descriptor.enumerable) |
        (Number(descriptor.configurable) << 1) |
        (Number(descriptor.writable) << 2);
      fields.push([key, flags, capture(descriptor.value, depth + 1)]);
    }
    visiting.delete(value);
    return {
      identity: value,
      fields,
      shape,
      extensible: Object.isExtensible(value),
    };
  }
  try {
    return { value: capture(message, 0) };
  } catch (error) {
    if (error !== unsupported) throw error;
    return undefined;
  }
}

const unsupported = Symbol("custom message cannot be verified by value");

export function snapshotField(
  snapshot: CustomSnapshot,
  field: string,
): CustomSnapshot {
  if (snapshot === null || typeof snapshot !== "object") return undefined;
  return snapshot.fields.find(([key]) => key === field)?.[2];
}

/** Compare only the text consumed by Pi's default custom message renderer. */
export function sameNativeCustomBody(
  a: CustomSnapshot,
  b: CustomSnapshot,
): boolean {
  const rendered = (body: CustomSnapshot): string => {
    if (typeof body === "string") return body;
    if (body == null || typeof body !== "object" || body.shape !== "array")
      return "";
    const lines: string[] = [];
    for (const [key, , block] of body.fields) {
      const index = Number(key);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= 0xffff_ffff ||
        String(index) !== key
      )
        continue;
      if (snapshotField(block, "type") !== "text") continue;
      const text = snapshotField(block, "text");
      if (typeof text === "string") lines.push(text);
    }
    return lines.join("\n");
  };
  return Object.is(a, b) || rendered(a) === rendered(b);
}

/** Index only existing own array elements; avoid getters, proxies and sparse length scans. */
export function customArrayIndices(value: readonly unknown[]): string[] {
  if (types.isProxy(value)) return [];
  return Object.getOwnPropertyNames(value).filter((key) => {
    const index = Number(key);
    return (
      Number.isInteger(index) &&
      index >= 0 &&
      index < 0xffff_ffff &&
      String(index) === key
    );
  });
}

export function sameCustomSnapshot(
  a: CustomSnapshot,
  b: CustomSnapshot,
): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null
  )
    return false;
  if (
    a.identity !== b.identity ||
    a.shape !== b.shape ||
    a.extensible !== b.extensible ||
    a.fields.length !== b.fields.length
  )
    return false;
  return a.fields.every(([key, flags, value], index) => {
    const [otherKey, otherFlags, otherValue] = b.fields[index];
    return (
      key === otherKey &&
      flags === otherFlags &&
      sameCustomSnapshot(value, otherValue)
    );
  });
}
