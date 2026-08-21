import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../schemas/subtree-metadata.schema.json",
);
let SCHEMA;
try {
  SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
} catch (error) {
  throw new Error(`cannot load ${SCHEMA_PATH}: ${error.message}`);
}
const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]*$/;

function typeMatches(value, type) {
  switch (type) {
    case "null":
      return value === null;
    case "object":
      return (
        value !== null && typeof value === "object" && !Array.isArray(value)
      );
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    default:
      return true;
  }
}

function schemaError(path, message) {
  throw new Error(`metadata schema violation at ${path}: ${message}`);
}

function validateSchema(value, schema, path = "$") {
  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    schemaError(path, `must equal ${JSON.stringify(schema.const)}`);
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      schemaError(path, `must be ${types.join(" or ")}`);
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      schemaError(path, `must contain at least ${schema.minLength} characters`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      schemaError(path, `must match ${schema.pattern}`);
    }
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) {
      schemaError(path, "must be an ISO date-time");
    }
  }

  if (schema.type === "object" && value !== null && !Array.isArray(value)) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        schemaError(path, `is missing required property ${required}`);
      }
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!known.has(key)) schemaError(`${path}.${key}`, "is not allowed");
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        validateSchema(value[key], childSchema, `${path}.${key}`);
      }
    }
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, index) =>
      validateSchema(item, schema.items, `${path}[${index}]`),
    );
  }
}

function parseMetadata(path) {
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${relative(process.cwd(), path)} is not valid JSON: ${error.message}`,
    );
  }
  validateSchema(metadata, SCHEMA);
  return metadata;
}

export function readSubtreeMetadata(root, name) {
  const file = name.endsWith(".json") ? name : `${name}.json`;
  const path = join(root, "subtrees", file);
  if (!existsSync(path)) {
    throw new Error(`${relative(root, path)} does not exist`);
  }

  const metadata = parseMetadata(path);
  const nameFromFile = basename(file, ".json");
  const expectedPrefix = `packages/${nameFromFile}`;
  const expectedRemote = `upstream-${nameFromFile}`;
  if (metadata.name !== nameFromFile || !PLUGIN_NAME.test(nameFromFile)) {
    throw new Error(
      `${relative(root, path)} must describe a valid unscoped package name`,
    );
  }
  if (metadata.prefix !== expectedPrefix) {
    throw new Error(`${relative(root, path)} prefix must be ${expectedPrefix}`);
  }
  if (metadata.remote !== expectedRemote) {
    throw new Error(`${relative(root, path)} remote must be ${expectedRemote}`);
  }

  const prefixPath = resolve(root, metadata.prefix);
  if (
    !prefixPath.startsWith(`${root}/`) ||
    !existsSync(prefixPath) ||
    !statSync(prefixPath).isDirectory()
  ) {
    throw new Error(
      `${relative(root, path)} points to missing ${metadata.prefix}`,
    );
  }

  return metadata;
}

export function listSubtreeMetadata(root) {
  const directory = join(root, "subtrees");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => readSubtreeMetadata(root, file));
}
