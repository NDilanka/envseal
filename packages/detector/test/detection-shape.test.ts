import { describe, expect, it } from 'vitest';
import { detect } from '../src/index.js';
import type { Detection } from '../src/index.js';

describe('detection shape', () => {
  it('never leaks the matched secret text in any detection field', () => {
    const secret = 'sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const text = `ANTHROPIC_API_KEY=${secret} and extra context around it`;
    const detections: Detection[] = detect(text);
    expect(detections.length).toBeGreaterThan(0);

    for (const detection of detections) {
      const fields: string[] = [
        detection.patternId,
        detection.label,
        detection.providerId ?? '',
        detection.confidence,
        String(detection.start),
        String(detection.end),
      ];
      for (const field of fields) {
        for (let i = 0; i + 9 <= secret.length; i++) {
          const chunk = secret.slice(i, i + 9);
          expect(field).not.toContain(chunk);
        }
      }
    }
  });
});
