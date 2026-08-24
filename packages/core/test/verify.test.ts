import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { asSecret } from '@envseal/protocol';
import { projectPaths } from '../src/paths.js';
import { verifyKey } from '../src/verify.js';
import type { ManifestEntry } from '@envseal/protocol';

describe('verify', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'envseal-test-'));
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  describe('verifyKey', () => {
    it('returns no_probe when no verify block', async () => {
      const paths = projectPaths(tmpDir);
      const entry: ManifestEntry = {
        key: 'TEST_KEY',
        description: 'Test',
      };
      const value = asSecret(Buffer.from('test-value', 'utf8'));

      const result = await verifyKey(paths, entry, value);

      expect(result.key).toBe('TEST_KEY');
      expect(result.result).toBe('no_probe');
    });

    it('requires https URL', async () => {
      const paths = projectPaths(tmpDir);
      const entry: ManifestEntry = {
        key: 'TEST_KEY',
        description: 'Test',
        verify: {
          method: 'GET',
          url: 'http://api.example.com/check',
          headerTemplate: { Authorization: 'Bearer {{value}}' },
          expectStatus: [200],
        },
      };
      const value = asSecret(Buffer.from('test-value', 'utf8'));

      const result = await verifyKey(paths, entry, value);

      expect(result.result).toBe('network_error');
    });

    it('rejects {{value}} in URL', async () => {
      const paths = projectPaths(tmpDir);
      const entry: ManifestEntry = {
        key: 'TEST_KEY',
        description: 'Test',
        verify: {
          method: 'GET',
          url: 'https://api.example.com/check?key={{value}}',
          headerTemplate: { Authorization: 'Bearer key' },
          expectStatus: [200],
        },
      };
      const value = asSecret(Buffer.from('test-value', 'utf8'));

      const result = await verifyKey(paths, entry, value);

      expect(result.result).toBe('network_error');
    });

    it('handles non-allowlisted host without approval', async () => {
      const fetch = vi.mocked(globalThis.fetch);
      const paths = projectPaths(tmpDir);
      const entry: ManifestEntry = {
        key: 'TEST_KEY',
        description: 'Test',
        verify: {
          method: 'GET',
          url: 'https://attacker.example/check',
          headerTemplate: { Authorization: 'Bearer {{value}}' },
          expectStatus: [200],
        },
      };
      const value = asSecret(Buffer.from('test-value', 'utf8'));

      const result = await verifyKey(paths, entry, value);

      expect(result.result).toBe('probe_not_approved');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('allows non-allowlisted host with onApprovalNeeded returning true', async () => {
      const fetch = vi.mocked(globalThis.fetch);
      fetch.mockResolvedValue(
        new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const paths = projectPaths(tmpDir);
      const entry: ManifestEntry = {
        key: 'TEST_KEY',
        description: 'Test',
        verify: {
          method: 'GET',
          url: 'https://attacker.example/check',
          headerTemplate: { Authorization: 'Bearer {{value}}' },
          expectStatus: [200],
        },
      };
      const value = asSecret(Buffer.from('test-value', 'utf8'));

      const result = await verifyKey(paths, entry, value, {
        onApprovalNeeded: async () => true,
      });

      expect(result.result).toBe('ok');
      expect(fetch).toHaveBeenCalled();
    });

    it('maps 401 to auth_failed', async () => {
      const fetch = vi.mocked(globalThis.fetch);
      fetch.mockResolvedValue(
        new Response('Unauthorized', {
          status: 401,
          headers: { 'content-type': 'text/plain' },
        }),
      );

      const paths = projectPaths(tmpDir);
      const entry: ManifestEntry = {
        key: 'TEST_KEY',
        description: 'Test',
        verify: {
          method: 'GET',
          url: 'https://api.openai.com/v1/models',
          headerTemplate: { Authorization: 'Bearer {{value}}' },
          expectStatus: [200],
        },
      };
      const value = asSecret(Buffer.from('test-value', 'utf8'));

      const result = await verifyKey(paths, entry, value);

      expect(result.result).toBe('auth_failed');
    });

    it('does not include response body in result', async () => {
      const fetch = vi.mocked(globalThis.fetch);
      fetch.mockResolvedValue(
        new Response('Secret key exposed in error message', {
          status: 401,
          headers: { 'content-type': 'text/plain' },
        }),
      );

      const paths = projectPaths(tmpDir);
      const entry: ManifestEntry = {
        key: 'TEST_KEY',
        description: 'Test',
        verify: {
          method: 'GET',
          url: 'https://api.openai.com/v1/models',
          headerTemplate: { Authorization: 'Bearer {{value}}' },
          expectStatus: [200],
        },
      };
      const value = asSecret(Buffer.from('test-value', 'utf8'));

      const result = await verifyKey(paths, entry, value);

      expect(result.message).not.toContain('Secret key exposed');
      expect(result.message).toContain('401');
    });

    it('does not follow redirects', async () => {
      const fetch = vi.mocked(globalThis.fetch);
      const response = new Response('', {
        status: 302,
        headers: { 'Location': 'https://evil.example/steal' },
      });
      fetch.mockResolvedValue(response);

      const paths = projectPaths(tmpDir);
      const entry: ManifestEntry = {
        key: 'TEST_KEY',
        description: 'Test',
        verify: {
          method: 'GET',
          url: 'https://api.openai.com/v1/models',
          headerTemplate: { Authorization: 'Bearer {{value}}' },
          expectStatus: [200],
        },
      };
      const value = asSecret(Buffer.from('test-value', 'utf8'));

      await verifyKey(paths, entry, value);

      expect(fetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          redirect: 'manual',
        }),
      );
    });
  });
});
