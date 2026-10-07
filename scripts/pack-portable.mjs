// Local Windows package only: no signing, publishing or settings access.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Missing binaries and equal timestamps also fail: each executable must be strictly newer. */
export const staleBinaries = (binaries, newestSourceMs) => binaries
  .filter(({ mtimeMs }) => !Number.isFinite(mtimeMs) || mtimeMs <= newestSourceMs)
  .map(({ name }) => name);

export const blockingDirtyFiles = (paths) => paths.filter((path) => {
  const normalized = path.replaceAll('\\', '/');
  return !normalized.startsWith('docs/') && !/\.md$/i.test(normalized);
});

export const packageNames = (version) => {
  if (typeof version !== 'string' || version.trim() !== version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) {
    throw new Error('Invalid package version: expected x.y.z or x.y.z-prerelease.');
  }
  const name = `raio-v${version}-windows-x64`;
  return { name, zipName: `${name}.zip`, manifestName: `SHA256SUMS-v${version}.txt` };
};

export const sha256Manifest = (entries) => entries.map(({ name, sha256 }) => `${sha256}  ${name}\n`).join('');

export const portableReadme = ({ sha, buildTime, hashes, dirty }) => `Raio - portable local package (Windows x64)

Commit: ${sha}
Build time (latest executable modification time, UTC): ${buildTime}
${dirty ? 'Built with --allow-dirty: uncommitted tracked changes may be included; the commit alone does not identify this build.' : 'Tracked tree clean outside docs/ and *.md at packaging time.'}

SHA256
raio.exe: ${hashes['raio.exe']}
raio-hook.exe: ${hashes['raio-hook.exe']}

Run
Keep both executables together. Windows x64 and the Microsoft WebView2 runtime are required.
Open raio.exe, choose a project folder, review the settings preview, then Connect.
Switch surfaces from the tray; quit from the tray icon when finished.
This local build is unsigned. Windows SmartScreen may warn. Keep OS protections enabled.

Moving this folder
Hooks of connected projects point at this folder's raio-hook.exe.
Disconnect those projects before moving the folder, quit from the tray, then run
raio.exe in its new location and Reconnect each project through the settings preview.

Local data
%APPDATA%\\io.github.gardim1.raio

Remove
Disconnect all connected projects first, quit Raio from the tray, then delete this
package folder and %APPDATA%\\io.github.gardim1.raio (deletes Raio's local history).
You may also delete the package zip. No installer or uninstaller is involved.
`;

const newestFileTime = (directory) => {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Cannot verify source freshness through a symbolic link: ${path}`);
    if (entry.isDirectory()) newest = Math.max(newest, newestFileTime(path));
    else if (entry.isFile()) newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
};

const pack = () => {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--allow-dirty')) throw new Error('Usage: npm run app:pack [-- --allow-dirty]');
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This package command requires Windows x64.');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const sha = git(['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('Could not establish the Git commit SHA.');
  // Check index and worktree independently: staged/unstaged changes can cancel in a diff against HEAD.
  const dirtyPaths = [...new Set([
    ...git(['diff', '--no-ext-diff', '--name-only', '--no-renames', '-z']).split('\0'),
    ...git(['diff', '--cached', '--no-ext-diff', '--name-only', '--no-renames', '-z']).split('\0'),
  ].filter(Boolean))];
  const blocked = blockingDirtyFiles(dirtyPaths);
  if (blocked.length) {
    console.error(`Tracked changes outside docs/ and *.md:\n${blocked.map((path) => `  ${JSON.stringify(path)}`).join('\n')}`);
    if (!args.includes('--allow-dirty')) throw new Error('Commit/review these changes first, or explicitly use npm run app:pack -- --allow-dirty.');
  }
  const newestSourceMs = Math.max(newestFileTime(join(root, 'src')), newestFileTime(join(root, 'src-tauri', 'src')));
  const binaries = ['raio.exe', 'raio-hook.exe'].map((name) => {
    const path = join(root, 'src-tauri', 'target', 'release', name);
    const info = existsSync(path) ? statSync(path) : null;
    return { name, path, mtimeMs: info?.isFile() ? info.mtimeMs : null };
  });
  const stale = staleBinaries(binaries, newestSourceMs);
  if (stale.length) throw new Error(`Missing or stale release executables: ${stale.join(', ')}. Run npm run app:build before packaging. --allow-dirty does not bypass freshness.`);

  const release = join(root, 'release-local');
  const { name, zipName, manifestName } = packageNames(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
  const folder = join(release, name);
  const zip = join(release, zipName);
  const manifest = join(release, manifestName);
  if ([folder, zip, manifest].some(existsSync)) throw new Error(`Package output already exists for version ${name}. Move it aside before retrying; connected hooks may reference it.`);
  mkdirSync(release, { recursive: true });
  mkdirSync(folder);
  const hashes = {};
  for (const binary of binaries) {
    const destination = join(folder, binary.name);
    copyFileSync(binary.path, destination);
    // Retain build timestamps and derive hashes from the files actually packaged.
    utimesSync(destination, binary.mtimeMs / 1000, binary.mtimeMs / 1000);
    hashes[binary.name] = createHash('sha256').update(readFileSync(destination)).digest('hex');
  }
  const buildMs = Math.max(...binaries.map(({ mtimeMs }) => mtimeMs));
  const readme = join(folder, 'README-PORTABLE.txt');
  writeFileSync(readme, portableReadme({ sha, buildTime: new Date(buildMs).toISOString(), hashes, dirty: blocked.length > 0 }), 'utf8');
  utimesSync(readme, buildMs / 1000, buildMs / 1000);
  console.log(`Created local portable folder: ${folder}`);
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  if (!existsSync(tar)) {
    console.log('Windows built-in tar.exe unavailable; zip skipped. The portable folder is ready.');
    return;
  }
  execFileSync(tar, ['-a', '-c', '-f', zip, '-C', release, name], { stdio: 'inherit' });
  writeFileSync(manifest, sha256Manifest([
    { name: zipName, sha256: createHash('sha256').update(readFileSync(zip)).digest('hex') },
    ...binaries.map(({ name: binary }) => ({ name: `${name}/${binary}`, sha256: hashes[binary] })),
  ]), { encoding: 'utf8', flag: 'wx' });
  console.log(`Created local zip: ${zip}`);
  console.log(`Created checksum manifest: ${manifest}`);
};

// Importing pure functions for unit tests must never run Git, tar, or packaging writes.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { pack(); }
  catch (error) {
    console.error(`Portable package failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
