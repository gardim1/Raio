import { useEffect, useRef } from 'react';
import { CharacterEngine } from './engine';
import { bindCharacterInteraction, characterLoop, characterRandom, characterReducedMotion, initializeCharacterFrame, mountCharacter } from './runtime';
import type { CharacterMode, CharacterSize } from './types';

interface DrawingProps { readonly size: CharacterSize; readonly mode: CharacterMode; readonly interactive?: boolean }
/** Same drawing mounted on a group for the map, or inside the public square SVG. */
export const CharacterDrawing = ({ size, mode, interactive = false }: DrawingProps) => {
  const host = useRef<SVGGElement>(null);
  const engine = useRef<CharacterEngine | null>(null);
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    const instance = new CharacterEngine(root, size, {
      reduced: characterReducedMotion, wake: characterLoop().wake, random: characterRandom,
      pointerGeometry: () => {
        // Use the group's world-to-screen matrix, not bounds enlarged by sparks/glow/particles.
        const m = root.getScreenCTM();
        return m ? { cx: m.e, cy: m.f, unit: Math.hypot(m.a, m.b) } : undefined;
      },
    });
    engine.current = instance;
    const unmount = mountCharacter(instance);
    const stopInteraction = interactive ? bindCharacterInteraction(instance) : undefined;
    if (!interactive) instance.hit.setAttribute('pointer-events', 'none');
    return () => { stopInteraction?.(); unmount(); engine.current = null; };
  }, [size, interactive]);
  useEffect(() => { if (engine.current) { engine.current.setMode(mode); initializeCharacterFrame(engine.current); } }, [size, interactive, mode]);
  return <g ref={host} className="raio-char__drawing" data-character-mode={mode} data-character-size={size} />;
};

export const RaioCharacter = ({ size, mode, interactive = false, label, className }: {
  readonly size: CharacterSize; readonly mode: CharacterMode; readonly interactive?: boolean; readonly label?: string; readonly className?: string;
}) => {
  const box = size === 'big' ? 300 : size === 'island' ? 28 : 44;
  return (
    <svg className={`raio-char raio-char--${size}${className ? ` ${className}` : ''}`} width={box} height={box}
      viewBox={size === 'big' ? '-40 -40 80 80' : '-22 -22 44 44'}
      role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false">
      <CharacterDrawing size={size} mode={mode} interactive={interactive} />
    </svg>
  );
};
