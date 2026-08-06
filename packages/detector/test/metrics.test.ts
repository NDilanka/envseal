import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detect } from '../src/index.js';

const currentDir = dirname(fileURLToPath(import.meta.url));

function readLines(relative: string): string[] {
  const raw = readFileSync(join(currentDir, 'fixtures', relative), 'utf-8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

describe('detector metrics', () => {
  it('meets recall and false-positive-rate requirements', () => {
    const positives = readLines('positive.txt');
    const negatives = readLines('negative.txt');

    let detectedPositives = 0;
    let highConfidencePositives = 0;
    const missed: string[] = [];

    for (const line of positives) {
      const detections = detect(line);
      if (detections.length > 0) {
        detectedPositives += 1;
        if (detections.some((d) => d.confidence === 'high')) {
          highConfidencePositives += 1;
        }
      } else {
        missed.push(line);
      }
    }

    let detectedNegatives = 0;
    const falsePositives: string[] = [];
    for (const line of negatives) {
      if (detect(line).length > 0) {
        detectedNegatives += 1;
        falsePositives.push(line);
      }
    }

    const recall = detectedPositives / positives.length;
    const highConfidenceRecall = highConfidencePositives / positives.length;
    const falsePositiveRate = detectedNegatives / negatives.length;

    console.log(`recall=${recall.toFixed(4)} (${detectedPositives}/${positives.length})`);
    console.log(
      `high-confidence-recall=${highConfidenceRecall.toFixed(4)} (${highConfidencePositives}/${positives.length})`
    );
    console.log(
      `false-positive-rate=${falsePositiveRate.toFixed(4)} (${detectedNegatives}/${negatives.length})`
    );

    if (missed.length > 0) {
      console.log('MISSED POSITIVE LINES:');
      for (const line of missed) {
        console.log(`  ${line}`);
      }
    }
    if (falsePositives.length > 0) {
      console.log('FALSE POSITIVE LINES:');
      for (const line of falsePositives) {
        console.log(`  ${line}`);
      }
    }

    expect(recall).toBeGreaterThanOrEqual(0.95);
    expect(falsePositiveRate).toBeLessThanOrEqual(0.02);
  });
});
