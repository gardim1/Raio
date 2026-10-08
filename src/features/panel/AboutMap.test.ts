import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ open: false }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: () => [state.open, (update: (current: boolean) => boolean) => { state.open = update(state.open); }],
  useId: () => 'map-disclosure-test',
}));
import { AboutMap } from './AboutMap';

it('starts collapsed with a named native button and a matching controlled region; activation toggles both', () => {
  state.open = false;
  const props = { details: ['Relationships between areas are unknown.'], technologies: ['Frontend · Next.js'] };
  const render = () => renderToStaticMarkup(createElement(AboutMap, props));
  expect(render()).toContain('aria-expanded="false" aria-controls="map-disclosure-test"');
  expect(render()).toContain('id="map-disclosure-test" hidden=""');
  expect(render()).toContain('aria-hidden="true"');
  expect(render()).toContain('About this map');
  const tree = AboutMap(props);
  const button = tree.props.children[1];
  expect(button.type).toBe('button'); expect(button.props.type).toBe('button');
  const stopPropagation = vi.fn(), preventDefault = vi.fn();
  button.props.onKeyDown({ key: ' ', stopPropagation, preventDefault });
  expect(stopPropagation).toHaveBeenCalledOnce();
  expect(preventDefault).not.toHaveBeenCalled(); // Preserve the browser's native Space activation.
  button.props.onKeyDown({ key: 'Enter', stopPropagation, preventDefault });
  expect(stopPropagation).toHaveBeenCalledOnce();
  button.props.onClick();
  expect(render()).toContain('aria-expanded="true"');
  expect(render()).not.toContain(' hidden=');
  expect(render()).toContain('Technology hints');
  AboutMap(props).props.children[1].props.onClick();
  expect(render()).toContain('aria-expanded="false"');
});
