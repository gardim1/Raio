import type { SessionLog } from './events';

const min = (m: number, s = 0) => (m * 60 + s) * 1000;

/** A realistic 14½-minute Claude Code session behind the canonical concept. */
export const demoSessionLog: SessionLog = {
  id: 'session-demo-google-auth',
  agent: 'claude',
  task: 'Add Google authentication',
  project: 'acme-web',
  startedAt: '2026-10-01T14:02:00Z',
  events: [
    { kind: 'session.start', atMs: 0 },
    { kind: 'file.read', atMs: min(0, 18), path: 'src/auth/session.ts', nodeId: 'auth' },
    { kind: 'file.read', atMs: min(0, 29), path: 'src/auth/providers/index.ts', nodeId: 'auth' },
    { kind: 'file.write', atMs: min(0, 41), path: 'src/auth/providers/google.ts', nodeId: 'auth', change: 'added' },
    { kind: 'file.write', atMs: min(1, 52), path: 'src/auth/providers/index.ts', nodeId: 'auth', change: 'modified' },
    { kind: 'file.write', atMs: min(2, 30), path: 'src/auth/callback.ts', nodeId: 'auth', change: 'added' },
    { kind: 'file.write', atMs: min(3, 12), path: 'web/components/LoginButton.tsx', nodeId: 'frontend', change: 'modified' },
    { kind: 'file.read', atMs: min(4, 40), path: 'server/routes/session.ts', nodeId: 'api' },
    { kind: 'file.write', atMs: min(6, 5), path: 'server/routes/session.ts', nodeId: 'api', change: 'modified' },
    { kind: 'file.write', atMs: min(7, 20), path: 'server/routes/oauth.ts', nodeId: 'api', change: 'added' },
    { kind: 'file.write', atMs: min(8, 40), path: 'db/migrations/0042_add_oauth_accounts.sql', nodeId: 'db', change: 'added' },
    { kind: 'risk', atMs: min(8, 47), nodeId: 'db', risk: 'migration', detail: 'Adds table oauth_accounts and a unique index on (provider, subject).' },
    { kind: 'validation', atMs: min(11, 30), validation: 'build', status: 'running' },
    { kind: 'validation', atMs: min(12, 58), validation: 'build', status: 'passed' },
    { kind: 'validation', atMs: min(13, 2), validation: 'tests', status: 'running' },
    { kind: 'validation', atMs: min(14, 3), validation: 'tests', status: 'passed' },
    { kind: 'session.end', atMs: min(14, 32), outcome: 'completed' },
  ],
};
