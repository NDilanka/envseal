import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import * as jsonc from 'jsonc-parser';
import type { FormattingOptions, ParseError } from 'jsonc-parser';
import { DeclareResult, Manifest, ManifestEntry, SepError } from '@envseal/protocol';
import type { Manifest as ManifestType } from '@envseal/protocol';
import type { ProjectPaths } from './paths.js';
import { appendAudit } from './audit.js';
import { scanText, scanManifestEntry, secretInDeclarationError, secretInManifestFileError } from './guard.js';

export function emptyManifest(): ManifestType {
  return { version: 1, entries: [] };
}

function readFileIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}

function detectFormat(text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^[ \t]+/m.exec(text)?.[0];
  const insertSpaces = indent === undefined ? true : !indent.startsWith('\t');
  const tabSize = indent !== undefined && insertSpaces ? indent.length : 2;
  return { insertSpaces, tabSize, eol };
}

const MANIFEST_FIELDS = ['$schema', 'version', 'entries'] as const;

/**
 * Load the manifest, or null when there is no manifest file.
 *
 * "Absent" and "unreadable" are different answers and must not share a return
 * value. Collapsing them meant a truncated or schema-invalid manifest read as
 * an empty one, and the next `env_declare` cheerfully wrote a fresh file over
 * it — silently discarding every prior declaration while the corrupting field
 * remained, so the cycle repeated. A corrupt manifest now throws; callers that
 * genuinely tolerate absence still get null.
 */
export function loadManifest(paths: ProjectPaths): ManifestType | null {
  const text = readFileIfPresent(paths.manifest);
  if (text === null) return null;

  const rawFinding = scanText('manifest', text, 'strict');
  if (rawFinding !== null) {
    appendAudit(paths, {
      type: 'blocked',
      reason: 'secret_in_declaration',
      detail: `${rawFinding.path}: ${rawFinding.label}`,
    });
    throw secretInManifestFileError(rawFinding);
  }

  const errors: ParseError[] = [];
  const value: unknown = jsonc.parse(text, errors, {
    disallowComments: false,
    allowTrailingComma: false,
    allowEmptyContent: false,
  });
  if (errors.length > 0) {
    throw new SepError({
      code: 'SEP_FORMAT_INVALID',
      userMessage:
        `${paths.manifest} is not valid JSONC and was not overwritten. ` +
        'Fix the syntax, or delete the file to start a fresh manifest.',
    });
  }

  const result = Manifest.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new SepError({
      code: 'SEP_FORMAT_INVALID',
      userMessage:
        `${paths.manifest} does not match the manifest schema and was not overwritten (${detail}). ` +
        'Fix the file, or delete it to start a fresh manifest.',
    });
  }
  return result.data;
}

function renderFreshManifest(manifest: ManifestType): string {
  const body = `{
  "version": ${manifest.version},
  "entries": ${JSON.stringify(manifest.entries, null, 2)}
}
`;
  return [
    '// envseal manifest — declares which environment variables this project uses.',
    '// Values are NEVER stored here; only metadata. Declare with env_declare.',
    '// JSON Schema: spec/sep-1/manifest.schema.json in the envseal repo (kept as a',
    '// comment: a $schema field would dangle in every project but this one).',
    body,
  ].join('\n');
}

export function saveManifest(paths: ProjectPaths, manifest: ManifestType): void {
  const text = readFileIfPresent(paths.manifest);
  if (text === null) {
    writeFileSync(paths.manifest, renderFreshManifest(manifest));
    return;
  }
  const errors: ParseError[] = [];
  const existing: unknown = jsonc.parse(text, errors, { disallowComments: false });
  if (typeof existing !== 'object' || existing === null) {
    throw new SepError({
      code: 'SEP_FORMAT_INVALID',
      details: 'Cannot edit an unparseable manifest without losing its comments.',
    });
  }
  const existingRecord = existing as Record<string, unknown>;
  const formatting = detectFormat(text);
  let out = text;
  for (const field of MANIFEST_FIELDS) {
    const next = (manifest as unknown as Record<string, unknown>)[field];
    if (next === undefined) continue;
    if (isDeepStrictEqual(existingRecord[field], next)) continue;
    const edits = jsonc.modify(out, [field], next, { formattingOptions: formatting });
    out = jsonc.applyEdits(out, edits);
  }
  writeFileSync(paths.manifest, out);
}

/**
 * Every write to `env.schema.jsonc` funnels through here — `Broker.declare` and
 * the CLI's `init` both call it — so this is where the secret-shaped-input
 * guard belongs. Placing it in `Broker.declare` alone would leave `envseal init`
 * unguarded, and placing it after `saveManifest` would be no guard at all.
 */
export function declareEntries(paths: ProjectPaths, entries: unknown[]): DeclareResult {
  const manifest = loadManifest(paths) ?? emptyManifest();
  const parsedEntries: ManifestType['entries'] = [];
  for (const [index, raw] of entries.entries()) {
    const result = ManifestEntry.safeParse(raw);
    if (!result.success) {
      const hasUnrecognized = result.error.issues.some((issue) => issue.code === 'unrecognized_keys');
      throw new SepError({
        code: hasUnrecognized ? 'SEP_VALUE_IN_REQUEST' : 'SEP_FORMAT_INVALID',
        details: result.error.flatten(),
      });
    }
    const finding = scanManifestEntry(result.data, `entries[${index}]`);
    if (finding !== null) {
      // §2.2 T3 wants the rejection logged as well as surfaced. The record
      // carries the field path and the pattern label — never the text that
      // matched, which is the whole reason we are refusing the write.
      appendAudit(paths, {
        type: 'blocked',
        reason: 'secret_in_declaration',
        detail: `${finding.path}: ${finding.label}`,
      });
      throw secretInDeclarationError(finding);
    }
    parsedEntries.push(result.data);
  }
  const byKey = new Map<string, ManifestType['entries'][number]>(manifest.entries.map((entry) => [entry.key, entry]));
  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  for (const entry of parsedEntries) {
    const existing = byKey.get(entry.key);
    if (existing === undefined) {
      byKey.set(entry.key, entry);
      added.push(entry.key);
    } else if (isDeepStrictEqual(existing, entry)) {
      unchanged.push(entry.key);
    } else {
      byKey.set(entry.key, entry);
      updated.push(entry.key);
    }
  }
  manifest.entries = [...byKey.values()];
  saveManifest(paths, manifest);
  return { added, updated, unchanged };
}
