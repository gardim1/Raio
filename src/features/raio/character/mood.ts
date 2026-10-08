import type { CompanionPresence } from '../../modes/companionPresence';
import type { UiFrame } from '../../session/model/evaluateFrame';
import type { CharacterMode, CharacterReaction } from './types';

export const characterMode = (companion: CompanionPresence | undefined): CharacterMode => {
  const state = companion?.state;
  return state === 'failure' || state === 'attention' || state === 'working' ? state : 'idle';
};
export const replayCharacterMode = (ui: Pick<UiFrame, 'status' | 'activeRisk'>): CharacterMode =>
  ui.status === 'failed' ? 'failure' : ui.activeRisk ? 'attention' : ui.status === 'working' ? 'working' : 'idle';

interface RoundFact { readonly id: string; readonly at: number; readonly kind: string }
/** Gate shared by this window's observers: consume suppressed facts, never queue a greeting. */
export class LiveRounds {
  private readonly seen = new Set<string>();
  private cutoff: number;
  constructor(mountedAt: number) { this.cutoff = mountedAt; }
  visibility(visible: boolean, now: number) { if (visible) this.cutoff = Math.max(this.cutoff, now); }
  observe(facts: readonly RoundFact[], opts: { replay: boolean; visible: boolean; now: number }): CharacterReaction[] {
    const reactions: CharacterReaction[] = [];
    for (const fact of facts) {
      if (fact.kind !== 'turn-end') continue;
      if (fact.at > opts.now || this.seen.has(fact.id)) continue;
      this.seen.add(fact.id);
      if (fact.kind === 'turn-end' && fact.at >= this.cutoff && !opts.replay && opts.visible) reactions.push('round');
    }
    return reactions;
  }
}
