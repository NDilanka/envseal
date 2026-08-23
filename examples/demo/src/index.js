// The consumer side of the demo: a plain script that needs a secret.
//
// It follows envseal's own discipline — never print the value. Presence plus
// a coarse length bucket is all any log should ever say about a secret.
const key = process.env.DEMO_API_KEY;

if (!key) {
  console.error('DEMO_API_KEY is not set. Run `envseal ensure` to provision it.');
  process.exit(1);
}

const bucket = key.length < 8 ? '<8' : key.length < 32 ? '8-31' : '32+';
console.log(`DEMO_API_KEY present (length bucket: ${bucket})`);
