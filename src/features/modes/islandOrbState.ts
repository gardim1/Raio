export type IslandOrbState = 'ready' | 'idle' | 'finished' | 'working' | 'replaying';

export interface IslandOrbInputs {
  readonly working: boolean;
  readonly replaying: boolean;
  readonly recentlyFinished: boolean;
  readonly finished: boolean;
}

/** The collapsed capsule's orb state; a change restarts its bounded idle float. */
export const islandOrbState = ({ working, replaying, recentlyFinished, finished }: IslandOrbInputs): IslandOrbState =>
  replaying ? 'replaying' : working ? 'working' : recentlyFinished ? 'finished' : finished ? 'idle' : 'ready';

export const islandOrbBobs = (state: IslandOrbState): boolean => state !== 'working' && state !== 'replaying';
