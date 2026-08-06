import { describe, it, expect } from 'vitest';
import { ping } from '../src/index.js';

describe('smoke', () => { it('works', () => { expect(ping()).toBe('pong'); }); });
