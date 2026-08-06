import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

describe('egress', () => {
  it('should only return responses via respond() or respondError()', () => {
    const toolsDir = resolve(process.cwd(), 'src/tools');
    const files = readdirSync(toolsDir).filter((f) => f.endsWith('.ts'));

    for (const file of files) {
      const source = readFileSync(resolve(toolsDir, file), 'utf-8');

      // Check for direct return statements with response objects
      // Pattern: return { ... content: ... }
      // This should NOT match because all returns should go through respond()
      const directReturnPattern =
        /return\s*\{\s*(?:.*?)\s*content\s*:/g;
      const directReturns = source.match(directReturnPattern);

      // Filter out false positives from respond/respondError function calls
      const invalidReturns = directReturns?.filter((match) => {
        // Check if this return is part of respond() or respondError() call
        const responseHelper = source.includes(
          `return respond(` || `return respondError(`
        );
        // If we're inside the tool handler, direct returns should not exist
        return !match.includes('respond');
      });

      // More precise check: look for handler function and ensure no direct returns
      const handlerMatch = source.match(
        /export\s+async\s+function\s+handler[\s\S]*?\{([\s\S]*?)\n\}/
      );
      if (handlerMatch) {
        const handlerBody = handlerMatch[1];
        // Should not have direct return { statements
        expect(
          handlerBody,
          `${file} handler should only return via respond() or respondError()`
        ).not.toMatch(/return\s*\{\s*(?!.*respond|.*respondError)/);
      }
    }
  });
});
