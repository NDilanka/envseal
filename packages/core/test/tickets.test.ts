import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TicketStore } from '../src/tickets.js';

describe('TicketStore', () => {
  let store: TicketStore;

  beforeEach(() => {
    store = new TicketStore();
  });

  afterEach(() => {
    store.dispose();
  });

  describe('create', () => {
    it('creates a ticket record', () => {
      const record = store.create({
        keys: ['KEY1', 'KEY2'],
        reason: 'Testing',
        surface: 'loopback-browser',
      });

      expect(record.ticket).toBeDefined();
      expect(record.nonce).toBeDefined();
      expect(record.keys).toEqual(['KEY1', 'KEY2']);
      expect(record.reason).toBe('Testing');
      expect(record.surface).toBe('loopback-browser');
      expect(record.state).toBe('pending');
      expect(record.outcomes.size).toBe(0);
    });

    it('generates ULID-format ticket IDs', () => {
      const record = store.create({
        keys: ['KEY'],
        reason: 'Test',
        surface: 'test',
      });

      // ULIDs are 26 characters
      expect(record.ticket).toMatch(/^[0-9A-Z]{26}$/);
    });

    it('generates nonce in AAAA-BBBB format', () => {
      const record = store.create({
        keys: ['KEY'],
        reason: 'Test',
        surface: 'test',
      });

      expect(record.nonce).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    });

    it('uses default TTL', () => {
      const before = Date.now();
      const record = store.create({
        keys: ['KEY'],
        reason: 'Test',
        surface: 'test',
      });
      const after = Date.now();

      expect(record.expiresAt).toBeGreaterThanOrEqual(before + 600_000 - 100);
      expect(record.expiresAt).toBeLessThanOrEqual(after + 600_000 + 100);
    });

    it('uses custom TTL', () => {
      const before = Date.now();
      const record = store.create({
        keys: ['KEY'],
        reason: 'Test',
        surface: 'test',
        ttlMs: 5000,
      });
      const after = Date.now();

      expect(record.expiresAt).toBeGreaterThanOrEqual(before + 5000 - 100);
      expect(record.expiresAt).toBeLessThanOrEqual(after + 5000 + 100);
    });
  });

  describe('get', () => {
    it('retrieves a ticket record', () => {
      const created = store.create({
        keys: ['KEY'],
        reason: 'Test',
        surface: 'test',
      });

      const retrieved = store.get(created.ticket);
      expect(retrieved).toEqual(created);
    });

    it('returns undefined for unknown ticket', () => {
      const result = store.get('unknown-ticket');
      expect(result).toBeUndefined();
    });
  });

  describe('setOutcome', () => {
    it('sets outcome for a key', () => {
      const record = store.create({
        keys: ['KEY1', 'KEY2'],
        reason: 'Test',
        surface: 'test',
      });

      store.setOutcome(record.ticket, 'KEY1', 'stored');

      const retrieved = store.get(record.ticket);
      expect(retrieved?.outcomes.get('KEY1')).toBe('stored');
      expect(retrieved?.outcomes.get('KEY2')).toBeUndefined();
    });
  });

  describe('resolve', () => {
    it('changes state to resolved', () => {
      const record = store.create({
        keys: ['KEY'],
        reason: 'Test',
        surface: 'test',
      });

      store.resolve(record.ticket);

      const retrieved = store.get(record.ticket);
      expect(retrieved?.state).toBe('resolved');
    });

    it('does nothing if ticket unknown', () => {
      expect(() => store.resolve('unknown')).not.toThrow();
    });
  });

  describe('cancel', () => {
    it('changes state to cancelled', () => {
      const record = store.create({
        keys: ['KEY'],
        reason: 'Test',
        surface: 'test',
      });

      store.cancel(record.ticket);

      const retrieved = store.get(record.ticket);
      expect(retrieved?.state).toBe('cancelled');
    });
  });

  describe('sweep', () => {
    it('expires pending tickets past TTL', () => {
      const record = store.create({
        keys: ['KEY'],
        reason: 'Test',
        surface: 'test',
        ttlMs: 100,
      });

      store.sweep(record.expiresAt + 1);

      const retrieved = store.get(record.ticket);
      expect(retrieved?.state).toBe('expired');
    });

    it('does not expire non-pending tickets', () => {
      const record = store.create({
        keys: ['KEY'],
        reason: 'Test',
        surface: 'test',
        ttlMs: 100,
      });

      store.resolve(record.ticket);
      store.sweep(record.expiresAt + 1);

      const retrieved = store.get(record.ticket);
      expect(retrieved?.state).toBe('resolved');
    });
  });

  describe('await', () => {
    it('resolves immediately if ticket unknown', async () => {
      const result = await store.await('unknown', 1000);
      expect(result.state).toBe('expired');
    });

    it('resolves early when state changes', async () => {
      const record = store.create({
        keys: ['KEY'],
        reason: 'Test',
        surface: 'test',
      });

      store.setOutcome(record.ticket, 'KEY', 'stored');

      // Start waiting
      const promise = store.await(record.ticket, 5000);

      // Resolve the ticket
      setTimeout(() => store.resolve(record.ticket), 50);

      const result = await promise;
      expect(result.state).toBe('resolved');
      expect(result.keys).toHaveLength(1);
    });

    it('times out when state does not change', async () => {
      const record = store.create({
        keys: ['KEY'],
        reason: 'Test',
        surface: 'test',
      });

      const start = Date.now();
      const result = await store.await(record.ticket, 100);
      const elapsed = Date.now() - start;

      expect(result.state).toBe('pending');
      expect(elapsed).toBeGreaterThanOrEqual(100 - 50);
    });

    it('returns outcomes when resolved', async () => {
      const record = store.create({
        keys: ['KEY1', 'KEY2'],
        reason: 'Test',
        surface: 'test',
      });

      store.setOutcome(record.ticket, 'KEY1', 'stored');
      store.setOutcome(record.ticket, 'KEY2', 'skipped');
      store.resolve(record.ticket);

      const result = await store.await(record.ticket, 1000);

      expect(result.keys).toHaveLength(2);
      const key1 = result.keys.find((k) => k.key === 'KEY1');
      const key2 = result.keys.find((k) => k.key === 'KEY2');
      expect(key1?.outcome).toBe('stored');
      expect(key2?.outcome).toBe('skipped');
    });
  });

  describe('dispose', () => {
    it('clears internal state', () => {
      const store = new TicketStore();
      const record = store.create({
        keys: ['KEY'],
        reason: 'Test',
        surface: 'test',
      });

      store.dispose();

      expect(record).toBeDefined();
    });
  });
});
