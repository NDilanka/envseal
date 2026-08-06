import { describe, it, expect } from 'vitest';
import * as describe_mod from '../src/tools/describe.js';
import * as declare_mod from '../src/tools/declare.js';
import * as request_mod from '../src/tools/request.js';
import * as await_mod from '../src/tools/await.js';
import * as verify_mod from '../src/tools/verify.js';
import * as use_mod from '../src/tools/use.js';
import * as revoke_mod from '../src/tools/revoke.js';
import { SEP_TOOL_NAMES } from '@envseal/protocol';

describe('tools', () => {
  it('should expose exactly seven tools', () => {
    const toolsList = [
      describe_mod,
      declare_mod,
      request_mod,
      await_mod,
      verify_mod,
      use_mod,
      revoke_mod,
    ];

    expect(toolsList).toHaveLength(7);
  });

  it('should have non-empty descriptions for all tools', () => {
    const toolsList = [
      describe_mod,
      declare_mod,
      request_mod,
      await_mod,
      verify_mod,
      use_mod,
      revoke_mod,
    ];

    for (const tool of toolsList) {
      expect(tool.description).toBeDefined();
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('should include never returns secret values in env_describe description', () => {
    expect(describe_mod.description.toLowerCase()).toContain(
      'never returns secret values'
    );
  });

  it('should expose all SEP_TOOL_NAMES', () => {
    const toolsList = [
      describe_mod,
      declare_mod,
      request_mod,
      await_mod,
      verify_mod,
      use_mod,
      revoke_mod,
    ];

    const toolNames = toolsList.map((t) => t.name);

    for (const sepToolName of SEP_TOOL_NAMES) {
      expect(toolNames).toContain(sepToolName);
    }
  });
});
