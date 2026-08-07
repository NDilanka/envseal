import { describe, it, expect } from 'vitest';
import { toolsFor } from '../src/index.js';
import { SEP_TOOL_NAMES } from '@envseal/protocol';

describe('toolsFor', () => {
  it('returns exactly 7 tools for openai', () => {
    const tools = toolsFor('openai') as any[];
    expect(tools).toHaveLength(7);

    const names = tools.map((t) => t.function.name);
    expect(names.sort()).toEqual([...SEP_TOOL_NAMES].sort());

    for (const tool of tools) {
      expect(tool.type).toBe('function');
      expect(tool.function).toBeDefined();
      expect(tool.function.name).toBeTruthy();
      expect(tool.function.description).toBeTruthy();
      expect(typeof tool.function.description).toBe('string');
      expect(tool.function.parameters).toBeDefined();
      expect(tool.function.parameters.type).toBe('object');
    }
  });

  it('returns exactly 7 tools for anthropic', () => {
    const tools = toolsFor('anthropic') as any[];
    expect(tools).toHaveLength(7);

    const names = tools.map((t) => t.name);
    expect(names.sort()).toEqual([...SEP_TOOL_NAMES].sort());

    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(typeof tool.description).toBe('string');
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe('object');
    }
  });

  it('returns exactly 7 tools for gemini', () => {
    const tools = toolsFor('gemini') as any[];
    expect(tools).toHaveLength(1);

    const functionDeclarations = tools[0].functionDeclarations;
    expect(functionDeclarations).toHaveLength(7);

    const names = functionDeclarations.map((t: any) => t.name);
    expect(names.sort()).toEqual([...SEP_TOOL_NAMES].sort());

    for (const func of functionDeclarations) {
      expect(func.name).toBeTruthy();
      expect(func.description).toBeTruthy();
      expect(typeof func.description).toBe('string');
      expect(func.parameters).toBeDefined();
      expect(func.parameters.type).toBe('object');
    }
  });

  it('includes all required fields in openai format', () => {
    const tools = toolsFor('openai') as any[];
    for (const tool of tools) {
      expect(tool.type).toBe('function');
      expect(tool.function.name).toMatch(/^env_/);
      expect(tool.function.description.length).toBeGreaterThan(10);
      expect(tool.function.parameters.properties).toBeDefined();
    }
  });

  it('includes all required fields in anthropic format', () => {
    const tools = toolsFor('anthropic') as any[];
    for (const tool of tools) {
      expect(tool.name).toMatch(/^env_/);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.input_schema.properties).toBeDefined();
    }
  });
});
