import { tokens } from './index';

/**
 * Publishes raio.tokens.json as CSS custom properties on :root so stylesheets
 * never hard-code a value. Naming: --raio-<group>-<path> in kebab-case.
 */
export const applyTokens = (root: HTMLElement = document.documentElement): void => {
  const set = (name: string, value: string | number) => root.style.setProperty(`--raio-${name}`, String(value));
  const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  const walk = (prefix: string, obj: unknown): void => {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const name = `${prefix}-${kebab(key)}`;
      if (typeof value === 'string') set(name, value);
      else if (typeof value === 'number') set(name, prefix.startsWith('motion-duration') ? `${value}ms` : `${value}px`);
      else walk(name, value);
    }
  };
  walk('color', tokens.color);
  walk('radius', tokens.radius);
  walk('blur', tokens.blur);
  walk('shadow', tokens.shadow);
  walk('motion-duration', tokens.motion.duration);
  walk('motion-easing', tokens.motion.easing);
  set('font-ui', tokens.typography.family.ui);
};
