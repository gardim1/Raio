import { create } from 'zustand';
import type { NodeId } from '../../architecture/model/types';

export type DisplayMode = 'film' | 'island' | 'mini' | 'expanded' | 'states';
export type PlaybackSource = 'live' | 'replay';

interface SessionUiState {
  readonly mode: DisplayMode;
  readonly source: PlaybackSource;
  readonly selectedNodeId: NodeId | null;
  readonly pinned: boolean;
  /** Bumped to restart the simulated live session. */
  readonly liveRun: number;
  /** Bumped to restart the replay from 0. */
  readonly replayRun: number;
  setMode(mode: DisplayMode): void;
  startReplay(): void;
  exitReplay(): void;
  selectNode(id: NodeId | null): void;
  togglePin(): void;
  restartLive(): void;
}

/** Client UI state (Zustand). Session data itself is derived, never stored here. */
export const useSessionUi = create<SessionUiState>((set) => ({
  mode: 'expanded',
  source: 'live',
  selectedNodeId: null,
  pinned: true,
  liveRun: 0,
  replayRun: 0,
  setMode: (mode) => set({ mode }),
  startReplay: () =>
    set((s) => ({
      source: 'replay',
      replayRun: s.replayRun + 1,
      selectedNodeId: null,
      mode: s.mode === 'island' || s.mode === 'film' || s.mode === 'states' ? 'mini' : s.mode,
    })),
  exitReplay: () => set({ source: 'live', selectedNodeId: null }),
  selectNode: (selectedNodeId) => set({ selectedNodeId }),
  togglePin: () => set((s) => ({ pinned: !s.pinned })),
  restartLive: () => set((s) => ({ liveRun: s.liveRun + 1, source: 'live', selectedNodeId: null })),
}));
