import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { RaioCharacter, requestCharacterReaction, type CharacterMode, type CharacterReaction } from '../features/raio/character';
import { characterLoop, setCharacterRandom, setCharacterReducedMotion } from '../features/raio/character/runtime';
import { frozenClock } from '../shared/motion/frozenClock';

const STATES: readonly [CharacterMode, string][] = [['idle', 'Waiting'], ['working', 'Agent working'], ['attention', 'Attention'], ['failure', 'Observed failure'], ['passed', 'Check passed again']];
const REACTIONS: readonly [CharacterReaction, string][] = [['click', 'One click'], ['dizzy', 'Several clicks'], ['cookie', 'Give a cookie'], ['round', 'Turn ended · tests not verified'], ['celebrate', 'Celebrate (simulated)']];

/** The reference's 1.9 / 3.4 / 6.2 s simulated sequence, driven by the same paused frame clock. */
export class CharacterBenchSequence {
  private time = 0;
  private pending: { at: number; run: () => void }[] = [];
  start(mode: (value: CharacterMode) => void, reaction: (kind: CharacterReaction) => void) {
    this.time = 0;
    mode('failure');
    this.pending = [{ at: 1.9, run: () => mode('working') }, { at: 3.4, run: () => { mode('passed'); reaction('celebrate'); } }, { at: 6.2, run: () => mode('idle') }];
  }
  cancel() { this.pending = []; }
  update(dt: number) {
    this.time += dt;
    while (this.pending[0] && this.time + 1e-9 >= this.pending[0].at) this.pending.shift()!.run();
    return this.pending.length > 0;
  }
  sense() {} leave() {} react() {}
}

interface CharacterCapture {
  __advance?: (seconds: number) => void;
  __state?: (mode: CharacterMode) => void;
  __react?: (kind: CharacterReaction | 'fixed') => void;
  __reduced?: (value: boolean) => void;
}
export const CharacterBench = () => {
  const [mode, setMode] = useState<CharacterMode>('idle');
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const sequence = useRef(new CharacterBenchSequence()).current;
  const capture = new URLSearchParams(window.location.search).has('capture');
  const change = (next: CharacterMode) => { sequence.cancel(); setMode(next); };
  const toggleReduced = (value: boolean) => { setReduced(value); setCharacterReducedMotion(value); };
  const react = (kind: CharacterReaction | 'fixed') => {
    if (kind === 'fixed') {
      sequence.start(next => flushSync(() => setMode(next)), requestCharacterReaction);
      characterLoop().wake();
    } else {
      if (kind === 'round') { sequence.cancel(); flushSync(() => setMode('idle')); }
      requestCharacterReaction(kind);
    }
  };
  // Before child passive mounts, put the simulated sequence first in the shared clock's order.
  useLayoutEffect(() => {
    characterLoop().setManual(capture || frozenClock() !== null);
    if (capture) setCharacterRandom(() => .5);
    const stop = characterLoop().add(sequence);
    return () => { sequence.cancel(); stop(); characterLoop().setManual(frozenClock() !== null); setCharacterRandom(frozenClock() !== null ? () => .5 : undefined); };
  }, [capture, sequence]);
  useEffect(() => {
    const target = window as Window & CharacterCapture;
    if (capture) {
      target.__advance = seconds => { flushSync(() => characterLoop().advance(seconds)); };
      target.__state = next => flushSync(() => change(next));
      target.__react = kind => flushSync(() => react(kind));
      target.__reduced = value => flushSync(() => toggleReduced(value));
    }
    return () => { delete target.__advance; delete target.__state; delete target.__react; delete target.__reduced; setCharacterReducedMotion(undefined); };
  }, [capture, sequence]);
  return <main className="character-bench" aria-label="Simulated character bench">
    <h1>Raio · approved character A</h1>
    <p>All states and events on this bench are simulated. Turn ended does not mean checks passed. Live celebration is blocked: the recorded command metadata cannot prove the same check passed again.</p>
    <div className="character-bench__controls" role="group" aria-label="Simulated character states">
      {STATES.map(([value, label]) => <button key={value} aria-pressed={mode === value} onClick={() => change(value)}>{label}</button>)}
    </div>
    <div className="character-bench__controls" role="group" aria-label="Simulated reactions">
      {REACTIONS.map(([value, label]) => <button key={value} onClick={() => react(value)}>{label}</button>)}
      <button onClick={() => react('fixed')}>Same check fails then passes (simulated)</button>
      <button aria-pressed={reduced} onClick={() => toggleReduced(!reduced)}>Reduced motion</button>
    </div>
    <div className="character-bench__sizes">
      <figure><div className="character-bench__stage"><RaioCharacter size="big" mode={mode} interactive label="Raio · large simulated character" /></div><figcaption>300 px stage · simulated {mode}</figcaption></figure>
      <figure><RaioCharacter size="map" mode={mode} interactive label="Raio · map size" /><figcaption>Map · 22 px body</figcaption></figure>
      <figure><RaioCharacter size="island" mode={mode} interactive label="Raio · Island size" /><figcaption>Island · 28 px box / 14 px body</figcaption></figure>
    </div>
  </main>;
};
