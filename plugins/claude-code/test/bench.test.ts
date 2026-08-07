import { describe, it, expect } from 'vitest';
import { decide, decideBash } from '../hooks/pre-tool-use.js';
import { redactUserMessage } from '../hooks/user-prompt-submit.js';

/**
 * Benchmark tests for hook performance.
 * Each hook must have p95 latency < 50ms when called directly.
 */

describe('hook performance benchmarks', () => {
  describe('pre-tool-use hook - direct function', () => {
    it('should have p95 latency < 50ms for allowed file read', () => {
      const latencies: number[] = [];
      const runs = 30;

      for (let i = 0; i < runs; i++) {
        const start = performance.now();
        decide({ tool: 'Read', path: 'src/index.ts' });
        const latency = performance.now() - start;
        latencies.push(latency);
      }

      latencies.sort((a, b) => a - b);
      const p95Index = Math.ceil(latencies.length * 0.95) - 1;
      const p95 = latencies[p95Index] ?? 0;

      console.log(`pre-tool-use (allowed read) p95: ${p95.toFixed(2)}ms`);
      expect(p95).toBeLessThan(50);
    });

    it('should have p95 latency < 50ms for denied file read', () => {
      const latencies: number[] = [];
      const runs = 30;

      for (let i = 0; i < runs; i++) {
        const start = performance.now();
        decide({ tool: 'Read', path: '.env' });
        const latency = performance.now() - start;
        latencies.push(latency);
      }

      latencies.sort((a, b) => a - b);
      const p95Index = Math.ceil(latencies.length * 0.95) - 1;
      const p95 = latencies[p95Index] ?? 0;

      console.log(`pre-tool-use (denied read) p95: ${p95.toFixed(2)}ms`);
      expect(p95).toBeLessThan(50);
    });

    it('should have p95 latency < 50ms for bash command analysis', () => {
      const latencies: number[] = [];
      const runs = 30;

      for (let i = 0; i < runs; i++) {
        const start = performance.now();
        decideBash('npm test', new Set());
        const latency = performance.now() - start;
        latencies.push(latency);
      }

      latencies.sort((a, b) => a - b);
      const p95Index = Math.ceil(latencies.length * 0.95) - 1;
      const p95 = latencies[p95Index] ?? 0;

      console.log(`pre-tool-use (bash analyze) p95: ${p95.toFixed(2)}ms`);
      expect(p95).toBeLessThan(50);
    });

    it('should have p95 latency < 50ms for bash command denial', () => {
      const latencies: number[] = [];
      const runs = 30;

      for (let i = 0; i < runs; i++) {
        const start = performance.now();
        decideBash('cat .env', new Set());
        const latency = performance.now() - start;
        latencies.push(latency);
      }

      latencies.sort((a, b) => a - b);
      const p95Index = Math.ceil(latencies.length * 0.95) - 1;
      const p95 = latencies[p95Index] ?? 0;

      console.log(`pre-tool-use (bash denial) p95: ${p95.toFixed(2)}ms`);
      expect(p95).toBeLessThan(50);
    });
  });

  describe('user-prompt-submit hook - direct function', () => {
    it('should have p95 latency < 50ms for clean messages', () => {
      const latencies: number[] = [];
      const runs = 30;
      const msg = 'This is a normal message about implementing features without any secrets';

      for (let i = 0; i < runs; i++) {
        const start = performance.now();
        redactUserMessage(msg);
        const latency = performance.now() - start;
        latencies.push(latency);
      }

      latencies.sort((a, b) => a - b);
      const p95Index = Math.ceil(latencies.length * 0.95) - 1;
      const p95 = latencies[p95Index] ?? 0;

      console.log(`user-prompt-submit (clean message) p95: ${p95.toFixed(2)}ms`);
      expect(p95).toBeLessThan(50);
    });

    it('should have p95 latency < 50ms for messages with potential secrets', () => {
      const latencies: number[] = [];
      const runs = 30;
      const msg = 'Test key: sk-proj-abcdefghijklmnopqrstuvwxyz';

      for (let i = 0; i < runs; i++) {
        const start = performance.now();
        redactUserMessage(msg);
        const latency = performance.now() - start;
        latencies.push(latency);
      }

      latencies.sort((a, b) => a - b);
      const p95Index = Math.ceil(latencies.length * 0.95) - 1;
      const p95 = latencies[p95Index] ?? 0;

      console.log(`user-prompt-submit (potential secret) p95: ${p95.toFixed(2)}ms`);
      expect(p95).toBeLessThan(50);
    });

    it('should have p95 latency < 50ms for bypass detection', () => {
      const latencies: number[] = [];
      const runs = 30;
      const msg = '/env:allow-once\nKey: sk-proj-secret';

      for (let i = 0; i < runs; i++) {
        const start = performance.now();
        redactUserMessage(msg);
        const latency = performance.now() - start;
        latencies.push(latency);
      }

      latencies.sort((a, b) => a - b);
      const p95Index = Math.ceil(latencies.length * 0.95) - 1;
      const p95 = latencies[p95Index] ?? 0;

      console.log(`user-prompt-submit (bypass detection) p95: ${p95.toFixed(2)}ms`);
      expect(p95).toBeLessThan(50);
    });
  });
});
