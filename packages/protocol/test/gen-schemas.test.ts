import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifestDocument, buildToolsDocument } from '../scripts/gen-schemas.js';

describe('JSON Schema generation is deterministic', () => {
  it('manifest.schema.json is byte-identical across runs', () => {
    const first = buildManifestDocument();
    const second = buildManifestDocument();
    expect(first).toBe(second);
    expect(Buffer.byteLength(first, 'utf8')).toBe(Buffer.byteLength(second, 'utf8'));
  });

  it('tools.schema.json is byte-identical across runs', () => {
    const first = buildToolsDocument();
    const second = buildToolsDocument();
    expect(first).toBe(second);
    expect(Buffer.byteLength(first, 'utf8')).toBe(Buffer.byteLength(second, 'utf8'));
  });

  it('written files round-trip byte-identically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'envseal-gen-'));
    const writes = [
      { file: 'manifest.schema.json', doc: buildManifestDocument() },
      { file: 'tools.schema.json', doc: buildToolsDocument() },
    ];
    for (const { file, doc } of writes) {
      writeFileSync(join(dir, file), doc, 'utf8');
    }
    for (const { file, doc } of writes) {
      expect(readFileSync(join(dir, file), 'utf8')).toBe(doc);
    }
  });
});
