import { demoGraph } from '../features/architecture/model/demoProject';
import { demoSessionLog } from '../features/session/model/demoSession';
import type { DesktopBridge, SessionSnapshot } from './desktopBridge';

/** The demo session behind the approved concept. Always labelled as a fixture. */
export const demoSnapshot: SessionSnapshot = {
  provenance: 'fixture',
  project: demoSessionLog.project,
  graph: demoGraph,
  log: demoSessionLog,
};

/** A static bridge for the browser, tests and the dev harness. Never reports live data. */
export const createFixtureBridge = (snapshot: SessionSnapshot | null = demoSnapshot): DesktopBridge => {
  if (snapshot && snapshot.provenance !== 'fixture') {
    throw new Error('Fixture bridge only serves fixture data');
  }
  return {
    kind: 'fixture',
    currentSession: () => snapshot,
    subscribe: () => () => {},
  };
};
