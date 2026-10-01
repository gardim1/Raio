// Fails the build if development-harness code or demo-review chrome leaks into the product bundle.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const FORBIDDEN = ['Prototype controls', 'Dev harness', 'harness-label', 'dock__seg', 'Concept film', 'Run live session', 'gallery__grid'];

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(js|css|html)$/.test(name)) files.push(path);
  }
};
walk(DIST);

const leaks = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const marker of FORBIDDEN) if (text.includes(marker)) leaks.push(`${file}: "${marker}"`);
}
if (files.some((f) => /harness/i.test(f))) leaks.push('a harness file was emitted into dist/');

if (leaks.length) {
  console.error(`Product bundle contains dev-harness code:\n  ${leaks.join('\n  ')}`);
  process.exit(1);
}
console.log(`Product bundle check passed (${files.length} files scanned, no harness markers).`);
