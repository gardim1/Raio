// Third-party notices for the Windows package: the Rust crates compiled into raio.exe / raio-hook.exe, the npm packages
// bundled into the renderer, and the bundled font. Reads local metadata only (no network).
//
// Usage: node scripts/third-party-notices.mjs <output file> [--cargo-metadata <cargo metadata JSON file>]
// Without --cargo-metadata it runs `cargo metadata --offline` itself (cargo must be on PATH).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = 'x86_64-pc-windows-msvc';
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)([-._].*)?$/i;

export const licenseFiles = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [])
  .filter((e) => e.isFile() && LICENSE_FILE.test(e.name))
  .map((e) => e.name)
  .sort();

/** Packages reachable from the root through normal (shipped) dependencies; build and dev dependencies are excluded. */
export const shippedCrates = (metadata) => {
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const queue = [metadata.resolve.root];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (dep.dep_kinds.some((k) => k.kind === null)) queue.push(dep.pkg);
    }
  }
  seen.delete(metadata.resolve.root);
  return metadata.packages.filter((p) => seen.has(p.id)).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
};

/** npm packages reachable from package.json "dependencies" in the lockfile (devDependencies excluded). */
export const shippedNpm = (lock) => {
  const packages = lock.packages;
  const seen = new Map();
  const queue = Object.keys(packages[''].dependencies ?? {});
  while (queue.length) {
    const name = queue.shift();
    const key = `node_modules/${name}`;
    const entry = packages[key];
    if (!entry || seen.has(key) || entry.dev) continue;
    seen.set(key, { name, version: entry.version, license: entry.license ?? 'UNKNOWN' });
    queue.push(...Object.keys(entry.dependencies ?? {}));
  }
  return [...seen.entries()].map(([path, p]) => ({ ...p, path })).sort((a, b) => a.name.localeCompare(b.name));
};

const NOTICES = join(ROOT, 'scripts', 'notices');

/** Notice kept in this repository for a component that ships without its own license file (by name or crate family). */
export const fallbackNotice = (name, dir = NOTICES) =>
  [name, name.replace(/-(sys|macros)$/, '')].map((n) => join(dir, `${n}.txt`)).find((path) => existsSync(path)) ?? null;

/** Every component carries its license text, from its own files or from scripts/notices; otherwise it is recorded as missing. */
const section = (missing, name, title, license, source, dir, files) => {
  let texts = files.map((f) => `--- ${f} ---\n${readFileSync(join(dir, f), 'utf8').trim()}\n`);
  if (!texts.length) {
    const fallback = fallbackNotice(name);
    if (fallback) texts = [`--- notice kept by Raio (scripts/notices) ---\n${readFileSync(fallback, 'utf8').trim()}\n`];
    else missing.push(title);
  }
  return [`==== ${title}`, `License: ${license}`, source ? `Source: ${source}` : null,
    texts.length ? texts.join('\n') : '(LICENSE TEXT MISSING)', ''].filter((l) => l !== null).join('\n');
};

const main = () => {
  const args = process.argv.slice(2);
  const out = args[0];
  if (!out) throw new Error('usage: third-party-notices.mjs <output file> [--cargo-metadata <file>]');
  const metaIndex = args.indexOf('--cargo-metadata');
  const metadataText = metaIndex > 0
    ? readFileSync(args[metaIndex + 1], 'utf8')
    : execFileSync('cargo', ['metadata', '--offline', '--format-version', '1', '--filter-platform', TARGET, '--manifest-path', join(ROOT, 'src-tauri', 'Cargo.toml')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const metadata = JSON.parse(metadataText.slice(metadataText.indexOf('{')));
  const crates = shippedCrates(metadata);
  const npm = shippedNpm(JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')));
  const unknown = [...crates.filter((c) => !c.license), ...npm.filter((p) => p.license === 'UNKNOWN')].map((p) => `${p.name} ${p.version}`);
  const missing = [];

  const parts = [
    'Raio - third-party notices',
    `Generated from Cargo metadata (${TARGET}, shipped dependencies only) and package-lock.json runtime dependencies.`,
    `Rust crates: ${crates.length}. npm packages: ${npm.length}. Font: 1.`,
    'Source code of every crate listed below (including the MPL-2.0 ones) is available unmodified from crates.io at the',
    'listed version and from the listed repository; npm packages from the npm registry at the listed version.',
    '',
    '#### Font',
    section(missing, 'inter', 'Inter (InterVariable.woff2)', 'OFL-1.1', 'https://github.com/rsms/inter', join(ROOT, 'public', 'fonts'), ['Inter-LICENSE.txt']),
    '#### npm packages bundled into the renderer',
    ...npm.map((p) => section(missing, p.name, `${p.name} ${p.version}`, p.license, null, join(ROOT, p.path), licenseFiles(join(ROOT, p.path)))),
    '#### Rust crates compiled into raio.exe and raio-hook.exe',
    ...crates.map((c) => section(missing, c.name, `${c.name} ${c.version}`, c.license ?? c.license_file ?? 'UNKNOWN', c.repository, dirname(c.manifest_path), licenseFiles(dirname(c.manifest_path)))),
  ];
  writeFileSync(out, parts.join('\n'));
  console.log(`Wrote ${out}: ${crates.length} crates, ${npm.length} npm packages, 1 font.`);
  if (unknown.length) console.error(`License identifier missing for: ${unknown.join(', ')}`);
  if (missing.length) console.error(`License text missing for: ${missing.join(', ')} (add scripts/notices/<name>.txt)`);
  if (unknown.length || missing.length) process.exitCode = 1;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
