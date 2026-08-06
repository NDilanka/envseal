import { describe, expect, it } from 'vitest';
import { detect, redactDetections } from '../src/index.js';

describe('redactDetections', () => {
  it('removes every detected substring from the redacted output', () => {
    const secret = 'sk-proj-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const text = `the key is ${secret} right there`;
    const detections = detect(text);
    expect(detections.length).toBeGreaterThan(0);
    const redacted = redactDetections(text, detections);
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain('X'.repeat(20));
  });

  it('replaces multiple detections on a single line', () => {
    const text =
      'AWS_ACCESS_KEY_ID=AKIA0000000000000000 and ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX and postgres://appuser:XXXXXXXXXXXXXXXX@db.example.com';
    const detections = detect(text);
    expect(detections.length).toBeGreaterThanOrEqual(3);
    const redacted = redactDetections(text, detections);
    expect(redacted).not.toContain('AKIA0000000000000000');
    expect(redacted).not.toContain('ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
    expect(redacted).not.toContain('XXXXXXXXXXXXXXXX@db.example.com');
  });

  it('keeps offsets correct with emoji and non-ASCII text before the secret', () => {
    const secret = 'ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const text = `Привет 👋 你好: ${secret} !`;
    const detections = detect(text);
    expect(detections.length).toBeGreaterThan(0);
    const redacted = redactDetections(text, detections);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain('Привет 👋 你好: ');
    expect(redacted).toContain(' !');
    expect(redacted).toContain('«redacted:');
  });
});
