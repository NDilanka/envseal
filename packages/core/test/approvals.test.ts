import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectPaths } from '../src/paths.js';
import { probeApprovalId, isProbeApproved, recordProbeApproval, isHostAllowlisted } from '../src/approvals.js';
import type { ManifestEntry } from '@envseal/protocol';

describe('approvals', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'envseal-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('probeApprovalId', () => {
    it('generates unique id for different URLs', () => {
      const entry1: ManifestEntry = {
        key: 'TEST_KEY',
        description: 'Test',
        verify: {
          method: 'GET',
          url: 'https://api1.example.com/check',
          headerTemplate: { Authorization: 'Bearer {{value}}' },
          expectStatus: [200],
        },
      };

      const entry2: ManifestEntry = {
        key: 'TEST_KEY',
        description: 'Test',
        verify: {
          method: 'GET',
          url: 'https://api2.example.com/check',
          headerTemplate: { Authorization: 'Bearer {{value}}' },
          expectStatus: [200],
        },
      };

      const id1 = probeApprovalId(entry1);
      const id2 = probeApprovalId(entry2);

      expect(id1).not.toBe(id2);
      expect(id1).toHaveLength(64);
      expect(id2).toHaveLength(64);
    });

    it('generates unique id for different methods', () => {
      const entry1: ManifestEntry = {
        key: 'TEST_KEY',
        description: 'Test',
        verify: {
          method: 'GET',
          url: 'https://api.example.com/check',
          headerTemplate: { Authorization: 'Bearer {{value}}' },
          expectStatus: [200],
        },
      };

      const entry2: ManifestEntry = {
        key: 'TEST_KEY',
        description: 'Test',
        verify: {
          method: 'POST',
          url: 'https://api.example.com/check',
          headerTemplate: { Authorization: 'Bearer {{value}}' },
          expectStatus: [200],
        },
      };

      const id1 = probeApprovalId(entry1);
      const id2 = probeApprovalId(entry2);

      expect(id1).not.toBe(id2);
    });

    it('generates unique id for different header templates', () => {
      const entry1: ManifestEntry = {
        key: 'TEST_KEY',
        description: 'Test',
        verify: {
          method: 'GET',
          url: 'https://api.example.com/check',
          headerTemplate: { Authorization: 'Bearer {{value}}' },
          expectStatus: [200],
        },
      };

      const entry2: ManifestEntry = {
        key: 'TEST_KEY',
        description: 'Test',
        verify: {
          method: 'GET',
          url: 'https://api.example.com/check',
          headerTemplate: { 'X-API-Key': '{{value}}' },
          expectStatus: [200],
        },
      };

      const id1 = probeApprovalId(entry1);
      const id2 = probeApprovalId(entry2);

      expect(id1).not.toBe(id2);
    });
  });

  describe('isProbeApproved / recordProbeApproval', () => {
    it('initially not approved', () => {
      const paths = projectPaths(tmpDir);
      const entry: ManifestEntry = {
        key: 'TEST_KEY',
        description: 'Test',
        verify: {
          method: 'GET',
          url: 'https://api.example.com/check',
          headerTemplate: { Authorization: 'Bearer {{value}}' },
          expectStatus: [200],
        },
      };

      expect(isProbeApproved(paths, entry)).toBe(false);
    });

    it('approved after recording', () => {
      const paths = projectPaths(tmpDir);
      const entry: ManifestEntry = {
        key: 'TEST_KEY',
        description: 'Test',
        verify: {
          method: 'GET',
          url: 'https://api.example.com/check',
          headerTemplate: { Authorization: 'Bearer {{value}}' },
          expectStatus: [200],
        },
      };

      recordProbeApproval(paths, entry);
      expect(isProbeApproved(paths, entry)).toBe(true);
    });

    it('approval invalidated by URL change', () => {
      const paths = projectPaths(tmpDir);
      const entry1: ManifestEntry = {
        key: 'TEST_KEY',
        description: 'Test',
        verify: {
          method: 'GET',
          url: 'https://api.example.com/check',
          headerTemplate: { Authorization: 'Bearer {{value}}' },
          expectStatus: [200],
        },
      };

      recordProbeApproval(paths, entry1);
      expect(isProbeApproved(paths, entry1)).toBe(true);

      const entry2: ManifestEntry = {
        ...entry1,
        verify: {
          ...entry1.verify,
          url: 'https://api2.example.com/check',
        },
      };

      expect(isProbeApproved(paths, entry2)).toBe(false);
    });
  });

  describe('isHostAllowlisted', () => {
    it('returns true for api.openai.com', () => {
      expect(isHostAllowlisted('https://api.openai.com/v1/models')).toBe(true);
    });

    it('returns false for attacker.example', () => {
      expect(isHostAllowlisted('https://attacker.example/collect')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isHostAllowlisted('not a url')).toBe(false);
    });
  });
});
