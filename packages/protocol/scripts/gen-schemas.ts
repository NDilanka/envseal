import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import {
  Manifest,
  SEP_TOOL_NAMES,
  INPUT_SCHEMAS,
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '../../../spec/sep-1');
const JSON_SCHEMA_ID = 'https://json-schema.org/draft/2020-12/schema';
const MANIFEST_ID = 'https://envseal.dev/spec/sep-1/manifest.schema.json';
const TOOLS_ID = 'https://envseal.dev/spec/sep-1/tools.schema.json';

function toJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema, { $refStrategy: 'none' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export function buildManifestDocument(): string {
  const schema = toJsonSchema(Manifest);
  const doc = {
    $schema: JSON_SCHEMA_ID,
    $id: MANIFEST_ID,
    title: 'EnvSeal SEP/1 manifest',
    ...schema,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function buildToolsDocument(): string {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const name of SEP_TOOL_NAMES) {
    const schema = INPUT_SCHEMAS[name];
    if (!schema) {
      throw new Error(`missing input schema for tool ${name}`);
    }
    properties[name] = toJsonSchema(schema);
    required.push(name);
  }
  const toolNames = Object.keys(INPUT_SCHEMAS);
  for (const name of toolNames) {
    if (!SEP_TOOL_NAMES.includes(name as (typeof SEP_TOOL_NAMES)[number])) {
      throw new Error(`no tool name declared for input schema ${name}`);
    }
  }
  const doc = {
    $schema: JSON_SCHEMA_ID,
    $id: TOOLS_ID,
    title: 'EnvSeal SEP/1 tools',
    type: 'object',
    additionalProperties: false,
    required: ['tools'],
    properties: {
      tools: {
        type: 'object',
        additionalProperties: false,
        required,
        properties,
      },
    },
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, 'manifest.schema.json'), buildManifestDocument(), 'utf8');
  writeFileSync(resolve(OUT_DIR, 'tools.schema.json'), buildToolsDocument(), 'utf8');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
