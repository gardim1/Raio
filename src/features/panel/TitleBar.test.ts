import { createElement, type MouseEvent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TitleBar, type TitleBarWindowApi } from './TitleBar';

const props = { project: 'fixture', agent: 'claude' as const, task: 'Fixture task', taskVisible: true, status: 'working' as const };
const windowApi = () => {
  const state = { closed: false, minimized: false, maximized: false, drags: 0 };
  const api: TitleBarWindowApi = {
    close: async () => { state.closed = true; },
    minimize: async () => { state.minimized = true; },
    toggleMaximize: async () => { state.maximized = !state.maximized; },
    startDragging: async () => { state.drags++; },
    isMaximized: async () => state.maximized,
    onResized: async () => () => {},
  };
  return { api, state };
};
const mouse = (detail = 1, interactive: string | null = null, button = 0) => ({
  button, buttons: button === 0 ? 1 : 2, detail,
  target: { closest: (selector: string) => interactive && selector.split(',').includes(interactive) ? {} : null },
  preventDefault: vi.fn(),
}) as unknown as MouseEvent<HTMLDivElement>;

describe('Expanded product titlebar chrome', () => {
  it('keeps browser dots decorative and provides no native drag handler', () => {
    const markup = renderToStaticMarkup(createElement(TitleBar, props));
    expect(markup).toContain('class="titlebar__dots" aria-hidden="true"><i></i><i></i><i></i>');
    expect(markup).not.toContain('<button');
    expect(TitleBar(props).props.onMouseDown).toBeUndefined();
  });

  it('puts Windows caption controls after the status/actions, without left dots', () => {
    const { api } = windowApi();
    const markup = renderToStaticMarkup(createElement(TitleBar, { ...props, nativeWindow: api, actions: createElement('button', null, 'Mode shortcut') }));
    expect([...markup.matchAll(/aria-label="([^"]+)"/g)].map(match => match[1])).toEqual([
      'Window controls', 'Minimize', 'Maximize', 'Close (Raio keeps running; quit from the tray)',
    ]);
    expect(markup).not.toContain('titlebar__dots');
    expect(markup).toContain('title="Close to tray · quit from the tray menu"');
    expect(markup.indexOf('Mode shortcut')).toBeLessThan(markup.indexOf('titlebar__caption'));
  });

  it('starts a native drag on a primary press in a noninteractive titlebar area', async () => {
    const { api, state } = windowApi();
    const bar = TitleBar({ ...props, nativeWindow: api });
    expect(typeof bar.props.onMouseDown).toBe('function');
    await bar.props.onMouseDown(mouse());
    expect(state.drags).toBe(1);
    expect(state.maximized).toBe(false);
  });

  it('toggles maximize on the second mouse press instead of starting another drag', async () => {
    const { api, state } = windowApi();
    const bar = TitleBar({ ...props, nativeWindow: api });
    expect(typeof bar.props.onMouseDown).toBe('function');
    await bar.props.onMouseDown(mouse(2));
    expect(state).toEqual({ closed: false, minimized: false, maximized: true, drags: 0 });
    await bar.props.onMouseDown(mouse(2));
    expect(state.maximized).toBe(false);
  });

  it.each(['button', 'a', 'input', 'textarea', 'select', '[role="button"]', '[contenteditable]:not([contenteditable="false"])', '.titlebar__task', '.mini-orb'])('does not drag or maximize from %s or its descendants', async (selector) => {
    const { api, state } = windowApi();
    const bar = TitleBar({ ...props, nativeWindow: api });
    expect(typeof bar.props.onMouseDown).toBe('function');
    const event = mouse(1, selector);
    await bar.props.onMouseDown(event);
    await bar.props.onMouseDown(mouse(2, selector));
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(state).toEqual({ closed: false, minimized: false, maximized: false, drags: 0 });
  });

  it('ignores secondary presses and mixed mouse buttons', async () => {
    const { api, state } = windowApi();
    const bar = TitleBar({ ...props, nativeWindow: api });
    await bar.props.onMouseDown(mouse(1, null, 2));
    await bar.props.onMouseDown({ ...mouse(), buttons: 3 });
    expect(state).toEqual({ closed: false, minimized: false, maximized: false, drags: 0 });
  });

  it('keeps windowDots=false callers free of controls even with an injected native API', () => {
    const { api } = windowApi();
    const markup = renderToStaticMarkup(createElement(TitleBar, { ...props, nativeWindow: api, windowDots: false }));
    expect(markup).not.toContain('titlebar__dots');
    expect(markup).not.toContain('<button');
  });
});
