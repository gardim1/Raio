// Opens the native Raio desktop app (development build). Not an installer.
// Usage: npm run app [-- --surface=island|mini|expanded] [-- --debug]
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const profile = args.includes('--debug') ? 'debug' : 'release';
const surface = args.find((a) => a.startsWith('--surface='));
if (surface && !['--surface=island', '--surface=mini', '--surface=expanded'].includes(surface)) {
  console.error(`Unknown ${surface}; use island, mini or expanded.`);
  process.exit(2);
}
const exe = join(root, 'src-tauri', 'target', profile, process.platform === 'win32' ? 'raio.exe' : 'raio');
const hook = join(root, 'src-tauri', 'target', profile, process.platform === 'win32' ? 'raio-hook.exe' : 'raio-hook');

if (!existsSync(exe)) {
  console.error(`No ${profile} build at ${exe}.`);
  console.error('Build it first: npm run app:build   (needs Rust + the MSVC toolchain on Windows; see README)');
  process.exit(1);
}
if (!existsSync(hook)) console.warn(`Warning: ${hook} is missing; connected projects will not record events.`);

// Warn when the binary is older than the last commit touching the app's sources (the build may be stale).
try {
  const last = Number(execFileSync('git', ['-C', root, 'log', '-1', '--format=%ct', '--', 'src', 'src-tauri/src', 'index.html'], { encoding: 'utf8' }).trim()) * 1000;
  const dirty = execFileSync('git', ['-C', root, 'status', '--porcelain', '--', 'src', 'src-tauri/src', 'index.html'], { encoding: 'utf8' }).trim();
  if (last > statSync(exe).mtimeMs) console.warn('Warning: this build is older than the latest committed source change; run npm run app:build.');
  if (dirty) console.warn('Warning: app sources have uncommitted changes that this build may not include.');
} catch { /* not a git checkout: skip the staleness hint */ }

const child = spawn(exe, surface ? [surface] : [], { detached: true, stdio: 'ignore' });
child.unref();
console.log(`Started the native Raio app (${profile}) ${surface ?? '(Expanded)'}. Quit from the tray icon.`);
console.log('This is the product. The browser review harness (fixture data, dev only) is: npm run dev:harness');
