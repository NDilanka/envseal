import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { SEP_TOOL_NAMES } from '@envseal/protocol';

describe('dialects', () => {
  beforeAll(() => {
    // Generate dialects
    try {
      execSync('pnpm gen:dialects', { cwd: process.cwd() });
    } catch (error) {
      console.error('Failed to generate dialects:', error);
    }
  });

  const dialects = [
    { file: 'mcp.tools.json', requiredFields: ['name', 'description', 'inputSchema'] },
    {
      file: 'openai.tools.json',
      requiredFields: ['type', 'function'],
      checkFunction: (data: unknown[]) => {
        expect(data[0]).toHaveProperty('function.name');
        expect(data[0]).toHaveProperty('function.description');
        expect(data[0]).toHaveProperty('function.parameters');
      },
    },
    { file: 'anthropic.tools.json', requiredFields: ['name', 'description', 'input_schema'] },
    {
      file: 'gemini.tools.json',
      requiredFields: ['functionDeclarations'],
      checkFunction: (data: Record<string, unknown>) => {
        const decls = data.functionDeclarations as unknown[];
        expect(decls.length).toBe(7);
        for (const decl of decls) {
          expect(decl).toHaveProperty('name');
          expect(decl).toHaveProperty('description');
          expect(decl).toHaveProperty('parameters');
        }
      },
    },
  ];

  for (const dialect of dialects) {
    it(`should generate ${dialect.file} with all tools`, () => {
      const path = resolve(process.cwd(), `spec/sep-1/dialects/${dialect.file}`);
      expect(existsSync(path), `${dialect.file} should exist`).toBe(true);

      const content = readFileSync(path, 'utf-8');
      const data = JSON.parse(content);

      // Check for Gemini format
      if (dialect.file === 'gemini.tools.json') {
        expect(data).toHaveProperty('functionDeclarations');
        const decls = data.functionDeclarations as unknown[];
        expect(decls.length).toBe(7);

        const toolNames = (decls as Record<string, string>[]).map(
          (d) => d.name
        );
        for (const toolName of SEP_TOOL_NAMES) {
          expect(toolNames).toContain(toolName);
        }
      } else {
        // Check array format
        const tools = Array.isArray(data) ? data : data.functionDeclarations;
        expect(tools.length).toBe(7);

        const toolNames = (tools as Record<string, string>[]).map(
          (t) => t.name || t.function?.name
        );
        for (const toolName of SEP_TOOL_NAMES) {
          expect(toolNames).toContain(toolName);
        }

        // Check required fields
        for (const tool of tools as Record<string, unknown>[]) {
          for (const field of dialect.requiredFields || []) {
            if (field === 'function') {
              expect(tool).toHaveProperty(field);
            } else if (field !== 'type') {
              expect(
                tool[field] || (tool.function as Record<string, unknown>)?.[field],
                `Tool should have ${field}`
              ).toBeDefined();
            }
          }
        }
      }

      if (dialect.checkFunction) {
        dialect.checkFunction(data);
      }
    });

    it(`should generate deterministic ${dialect.file}`, () => {
      const path = resolve(process.cwd(), `spec/sep-1/dialects/${dialect.file}`);

      // Read file twice and compare
      const content1 = readFileSync(path, 'utf-8');
      const data1 = JSON.parse(content1);

      // Regenerate
      try {
        execSync('pnpm gen:dialects', { cwd: process.cwd() });
      } catch (error) {
        console.error('Failed to regenerate dialects:', error);
      }

      const content2 = readFileSync(path, 'utf-8');
      const data2 = JSON.parse(content2);

      expect(JSON.stringify(data1)).toBe(JSON.stringify(data2));
    });
  }
});
