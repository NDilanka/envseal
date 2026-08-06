/**
 * In-memory ticket store. Records live only for the lifetime of the process and
 * are NEVER persisted anywhere. They hold metadata and per-key *outcomes*
 * (strings only) — never secret values.
 */
import { randomInt } from 'node:crypto';
import { ulid } from 'ulid';
import type { TicketKeyOutcome, TicketOutcome } from '@envseal/protocol';

export type TicketRecordState = 'pending' | 'resolved' | 'expired' | 'cancelled';

export interface TicketRecord {
  ticket: string;
  nonce: string;
  keys: string[];
  reason: string;
  surface: string;
  createdAt: number;
  expiresAt: number;
  state: TicketRecordState;
  outcomes: Map<string, TicketKeyOutcome>;
}

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function makeNonce(): string {
  let chars = '';
  for (let i = 0; i < 8; i++) {
    chars += CROCKFORD_BASE32[randomInt(CROCKFORD_BASE32.length)]!;
  }
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

const DEFAULT_TTL_MS = 600_000;
const SWEEP_INTERVAL_MS = 60_000;

export interface TicketStoreOptions {
  ttlMs?: number;
  sweepIntervalMs?: number;
}

export class TicketStore {
  private readonly records = new Map<string, TicketRecord>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly defaultTtlMs: number;

  constructor(options: TicketStoreOptions = {}) {
    this.defaultTtlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.timer = setInterval(() => this.sweep(), options.sweepIntervalMs ?? SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  create(opts: { keys: string[]; reason: string; surface: string; ttlMs?: number }): TicketRecord {
    const createdAt = Date.now();
    const record: TicketRecord = {
      ticket: ulid(),
      nonce: makeNonce(),
      keys: [...opts.keys],
      reason: opts.reason,
      surface: opts.surface,
      createdAt,
      expiresAt: createdAt + (opts.ttlMs ?? this.defaultTtlMs),
      state: 'pending',
      outcomes: new Map(),
    };
    this.records.set(record.ticket, record);
    return record;
  }

  get(ticket: string): TicketRecord | undefined {
    return this.records.get(ticket);
  }

  setOutcome(ticket: string, key: string, outcome: TicketKeyOutcome): void {
    const record = this.records.get(ticket);
    if (!record) return;
    record.outcomes.set(key, outcome);
  }

  resolve(ticket: string): void {
    const record = this.records.get(ticket);
    if (!record || record.state !== 'pending') return;
    record.state = 'resolved';
    this.bump(ticket);
  }

  cancel(ticket: string): void {
    const record = this.records.get(ticket);
    if (!record || record.state !== 'pending') return;
    record.state = 'cancelled';
    this.bump(ticket);
  }

  sweep(now: number = Date.now()): void {
    for (const record of this.records.values()) {
      if (record.state === 'pending' && record.expiresAt <= now) {
        record.state = 'expired';
        this.bump(record.ticket);
      }
    }
  }

  await(ticket: string, timeoutMs: number): Promise<TicketOutcome> {
    return new Promise<TicketOutcome>((resolvePromise) => {
      const record = this.records.get(ticket);
      if (!record) {
        resolvePromise({ ticket, state: 'expired', keys: [] });
        return;
      }
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const listener = () => {
        if (record.state !== 'pending') finish();
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        this.unsubscribe(ticket, listener);
        if (timeout !== undefined) clearTimeout(timeout);
        resolvePromise(this.toOutcome(record));
      };
      timeout = setTimeout(finish, timeoutMs);
      timeout.unref();
      this.subscribe(ticket, listener);
      if (record.state !== 'pending') finish();
    });
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const listeners of this.waiters.values()) {
      for (const listener of listeners) listener();
    }
    this.waiters.clear();
    this.records.clear();
  }

  private toOutcome(record: TicketRecord): TicketOutcome {
    const keys = [...record.outcomes.entries()].map(([key, outcome]) => ({ key, outcome }));
    return { ticket: record.ticket, state: record.state, keys };
  }

  private subscribe(ticket: string, listener: () => void): void {
    let set = this.waiters.get(ticket);
    if (set === undefined) {
      set = new Set();
      this.waiters.set(ticket, set);
    }
    set.add(listener);
  }

  private unsubscribe(ticket: string, listener: () => void): void {
    const set = this.waiters.get(ticket);
    if (set === undefined) return;
    set.delete(listener);
    if (set.size === 0) this.waiters.delete(ticket);
  }

  private bump(ticket: string): void {
    const set = this.waiters.get(ticket);
    if (set === undefined) return;
    for (const listener of set) {
      try {
        listener();
      } catch {
        // listeners must never throw out of a state transition
      }
    }
  }
}
