// Local Windows package only: no signing, publishing or settings access.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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

const PACK_USAGE = 'Usage: npm run app:pack [-- --allow-dirty] [--cargo-metadata <file>]';

export const parsePackArgs = (args) => {
  const options = { allowDirty: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--allow-dirty' && !options.allowDirty) options.allowDirty = true;
    else if (arg === '--cargo-metadata' && options.cargoMetadata === undefined) {
      const value = args[++i];
      if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw new Error(PACK_USAGE);
      options.cargoMetadata = value;
    } else throw new Error(PACK_USAGE);
  }
  return options;
};

/** Process failure propagates to pack's error handler; never create a zip without generated notices. */
export const writePackageNotices = ({ root, folder, cargoMetadata }, run = execFileSync) => {
  copyFileSync(join(root, 'LICENSE'), join(folder, 'LICENSE'));
  const args = [join(root, 'scripts', 'third-party-notices.mjs'), join(folder, 'THIRD-PARTY-NOTICES.txt')];
  if (cargoMetadata !== undefined) args.push('--cargo-metadata', cargoMetadata);
  run(process.execPath, args, { stdio: 'inherit' });
};

/** Reserve one immutable version directory, including partial failed attempts. */
export const createReleaseLayout = ({ releaseRoot, version }) => {
  const names = packageNames(version);
  const release = join(releaseRoot, `v${version}`);
  if (existsSync(release)) throw new Error(`Package output already exists for version v${version}. Move it aside before retrying; connected hooks may reference it.`);
  mkdirSync(releaseRoot, { recursive: true });
  // Non-recursive mkdir also refuses a concurrently created version directory.
  mkdirSync(release);
  const folder = join(release, names.name);
  mkdirSync(folder);
  return { ...names, release, folder, zip: join(release, names.zipName), manifest: join(release, names.manifestName), installer: join(release, 'install-raio.ps1') };
};

/** Hash only the bytes actually shipped alongside the versioned manifest. */
export const writeReleaseAssets = ({ root, release, zipName, manifestName }) => {
  const manifest = join(release, manifestName);
  if (existsSync(manifest)) throw new Error(`Checksum manifest already exists: ${manifest}`);
  const installer = join(release, 'install-raio.ps1');
  if (existsSync(installer)) throw new Error(`Installer already exists: ${installer}`);
  copyFileSync(join(root, 'scripts', 'install-raio.ps1'), installer, constants.COPYFILE_EXCL);
  const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
  writeFileSync(manifest, sha256Manifest([
    { name: zipName, sha256: digest(join(release, zipName)) },
    { name: 'install-raio.ps1', sha256: digest(installer) },
  ]), { encoding: 'utf8', flag: 'wx' });
};
export const portableReadme = ({ version, sha, buildTime, hashes, dirty }) => `Raio - portable local package (Windows x64)

Version: ${version}
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

Licenses
LICENSE contains Raio's MIT license. THIRD-PARTY-NOTICES.txt contains bundled
third-party dependency and font license notices.

Install (optional)
Each release keeps its zip, installer and checksum manifest together in
release-local/v${version}/, beside raio-v${version}-windows-x64/.
Use install-raio.ps1 from that version directory for stable per-user installation.
Before running a downloaded installer, from that directory run:
Get-FileHash -Algorithm SHA256 install-raio.ps1
Compare the result with its line in SHA256SUMS-v${version}.txt.
Then run: .\\install-raio.ps1 -Version '${version}' -Source .
The installer verifies the zip's exact-name checksum entry before extraction.

Moving this folder
Hooks of connected projects point at this folder's raio-hook.exe.
Disconnect those projects before moving the folder, quit from the tray, then run
raio.exe in its new location and Reconnect each project through the settings preview.

Local data
%APPDATA%\\io.github.gardim1.raio

Remove
Disconnect all connected projects first, quit Raio from the tray, then delete this
package folder and %APPDATA%\\io.github.gardim1.raio (deletes Raio's local history).
You may also delete the package zip. These steps are for direct portable use.
For installer-managed copies, use install-raio.ps1 -Uninstall; add -RemoveData
only if you also want to delete local history. Disconnect projects first.
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
  const { allowDirty, cargoMetadata } = parsePackArgs(process.argv.slice(2));
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This package command requires Windows x64.');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const required = ['LICENSE', 'scripts/third-party-notices.mjs', 'scripts/install-raio.ps1'];
  const missing = required.filter((path) => !existsSync(join(root, path)) || !statSync(join(root, path)).isFile());
  if (missing.length) throw new Error(`Missing packaging inputs: ${missing.join(', ')}`);
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
    if (!allowDirty) throw new Error('Commit/review these changes first, or explicitly use npm run app:pack -- --allow-dirty.');
  }
  const newestSourceMs = Math.max(newestFileTime(join(root, 'src')), newestFileTime(join(root, 'src-tauri', 'src')));
  const binaries = ['raio.exe', 'raio-hook.exe'].map((name) => {
    const path = join(root, 'src-tauri', 'target', 'release', name);
    const info = existsSync(path) ? statSync(path) : null;
    return { name, path, mtimeMs: info?.isFile() ? info.mtimeMs : null };
  });
  const stale = staleBinaries(binaries, newestSourceMs);
  if (stale.length) throw new Error(`Missing or stale release executables: ${stale.join(', ')}. Run npm run app:build before packaging. --allow-dirty does not bypass freshness.`);

  const tar = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe');
  if (!existsSync(tar)) throw new Error('Windows built-in tar.exe unavailable; cannot create complete release assets.');
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const { name, zipName, manifestName, release, folder, zip, manifest, installer } = createReleaseLayout({ releaseRoot: join(root, 'release-local'), version });
  writePackageNotices({ root, folder, cargoMetadata });
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
  writeFileSync(readme, portableReadme({ version, sha, buildTime: new Date(buildMs).toISOString(), hashes, dirty: blocked.length > 0 }), 'utf8');
  utimesSync(readme, buildMs / 1000, buildMs / 1000);
  console.log(`Created local portable folder: ${folder}`);
  execFileSync(tar, ['-a', '-c', '-f', zip, '-C', release, name], { stdio: 'inherit' });
  writeReleaseAssets({ root, release, zipName, manifestName });
  console.log(`Created local zip: ${zip}`);
  console.log(`Created installer: ${installer}`);
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
