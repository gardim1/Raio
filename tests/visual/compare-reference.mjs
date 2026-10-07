// Measures pixel deltas between harness film goldens and the design's reference keyframes.
// Informative only: the references were rendered from the original concept HTML, not this renderer.
// Usage: node tests/visual/compare-reference.mjs  (maintainer-only: reads local, unpublished files under .local/)
// Exits 2 when any comparison could not run, so a missing reference is never mistaken for a pass.
import { existsSync, readFileSync } from 'node:fs';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const REF = '.local/design-reference/raio-desktop-prototype-review/handoff/raio-handoff/assets/keyframes';
const OURS = '.local/visual/goldens';
const NAMES = ['01-idle', '02-agent-starts', '03-auth-active', '04-auth-to-api-traversal', '05-api-active', '06-database-warning', '07-migration-notification', '08-validations', '09-completed'];

let skipped = 0;
for (const name of NAMES) {
  const refPath = `${REF}/${name}.png`;
  const oursPath = `${OURS}/film-${name}.png`;
  if (!existsSync(refPath) || !existsSync(oursPath)) {
    console.log(`${name}: NOT COMPARED, missing ${existsSync(refPath) ? oursPath : refPath}`);
    skipped += 1;
    continue;
  }
  const a = PNG.sync.read(readFileSync(refPath));
  const b = PNG.sync.read(readFileSync(oursPath));
  if (a.width !== b.width || a.height !== b.height) {
    console.log(`${name}: NOT COMPARED, size differs (reference ${a.width}x${a.height}, ours ${b.width}x${b.height})`);
    skipped += 1;
    continue;
  }
  const diff = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 });
  console.log(`${name}: ${((diff / (a.width * a.height)) * 100).toFixed(2)}% pixels differ (threshold 0.1)`);
}
if (skipped) {
  console.log(`${skipped} of ${NAMES.length} comparisons did not run.`);
  process.exitCode = 2;
}
