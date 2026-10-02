import type { ProjectImports } from '../features/project/importEdges';
import type { ProjectInventory } from '../features/project/projectInventory';

/**
 * Import facts of the demo project ("acme-web"), in the shape the core's `project_imports` returns. The relative
 * imports between its systems reproduce exactly the relationships of the approved concept (frontend->auth, auth->api,
 * api->db, config->frontend, api->payments, api->storage, db->storage); a package, a stylesheet and a same-folder
 * import stay out of the edges. Fixture data only: never real telemetry.
 */
export const demoImportFacts: ProjectImports = {
  files: [
    { path: 'web/components/LoginButton.tsx', specifiers: ['../../src/auth/callback', 'react', './login.css'] },
    { path: 'web/theme.ts', specifiers: [] },
    { path: 'src/auth/callback.ts', specifiers: ['./providers/google', '../../server/routes/session'] },
    { path: 'src/auth/providers/google.ts', specifiers: ['../session'] },
    { path: 'src/auth/session.ts', specifiers: [] },
    { path: 'server/routes/session.ts', specifiers: ['../../db/client', '../../payments/charge', '../../storage/uploads', 'express'] },
    { path: 'db/client.ts', specifiers: ['../storage/uploads'] },
    { path: 'payments/charge.ts', specifiers: [] },
    { path: 'storage/uploads.ts', specifiers: [] },
    { path: 'config/env.ts', specifiers: ['../web/theme'] },
  ],
  truncated: false,
  skipped: 0,
  scannedAtMs: 0,
};

/**
 * Inventory of the demo project ("acme-web"), in the shape the core's `project_inventory` returns: the files behind
 * the demo's systems (the scanned ones plus a stylesheet and the root manifest) and a root `package.json` naming
 * React and Express. Grouping it gives one area per demo system (web, auth, server, db, payments, storage, config).
 * Fixture data only: never real telemetry.
 */
export const demoInventory: ProjectInventory = {
  files: ['package.json', 'web/components/login.css', ...demoImportFacts.files.map((f) => f.path)],
  truncated: false,
  skipped: 0,
  scannedAtMs: 0,
  manifests: [{ path: 'package.json', kind: 'npm', facts: { dependencies: ['express', 'react'], scripts: ['build', 'dev'] } }],
};

const DEMO_GROUP_BY_FOLDER: Readonly<Record<string, string>> = { web: 'frontend', server: 'api', db: 'db', payments: 'payments', storage: 'storage', config: 'config' };

/** The demo group (a node id of the demo graph) of a demo path, or null when it is not on the demo map. */
export const demoGroupOf = (path: string): string | null => {
  const [first, second] = path.split('/');
  if (first === 'src' && second === 'auth') return 'auth';
  return first === undefined ? null : (DEMO_GROUP_BY_FOLDER[first] ?? null);
};
