import { useEffect, useMemo, useState } from 'react';
import { isSurfaceVisible, subscribeSurfaceVisibility } from '../../../shared/motion/surfaceVisibility';
import type { CompanionPresence, PresenceFact } from '../../modes/companionPresence';
import { deriveCompanionPresence } from '../../modes/companionPresence';
import { runPresenceClock } from '../../modes/presenceClock';
import { LiveRounds, characterMode } from './mood';
import { requestCharacterReaction } from './runtime';
import { useCharacterObservation } from './useCharacterPresenceInput';

const noFacts: readonly PresenceFact[] = [];
let liveRounds: LiveRounds | undefined;
let observers = 0;
let stopVisibility: (() => void) | undefined;

export const useCharacterMood = (companion: CompanionPresence | undefined, opts: { replay: boolean }) => {
  const { input, now: presenceNow } = useCharacterObservation();
  const [, repaint] = useState(0);
  const mountedAt = useMemo(() => Date.now(), []);
  const facts = input?.facts ?? noFacts;
  useEffect(() => {
    const firstMount = liveRounds === undefined;
    liveRounds ??= new LiveRounds(mountedAt);
    if (observers++ === 0) {
      // React Activity disconnects effects while hidden, retaining the old render-time refs.
      liveRounds.visibility(isSurfaceVisible(), firstMount ? mountedAt : Date.now());
      stopVisibility = subscribeSurfaceVisibility(() => liveRounds?.visibility(isSurfaceVisible(), Date.now()));
    }
    return () => { if (--observers === 0) { stopVisibility?.(); stopVisibility = undefined; } };
  }, [mountedAt]);
  useEffect(() => {
    const now = Date.now();
    for (const reaction of liveRounds?.observe(facts, { replay: opts.replay, visible: isSurfaceVisible(), now }) ?? []) requestCharacterReaction(reaction);
  }, [facts, opts.replay]);
  useEffect(() => {
    if (companion !== undefined || !input || opts.replay) return;
    return runPresenceClock({ input, now: presenceNow, onChange: () => repaint(n => n + 1) });
  }, [input, presenceNow, companion, opts.replay]);
  return characterMode(companion ?? (input ? deriveCompanionPresence(input, presenceNow()) : undefined));
};
