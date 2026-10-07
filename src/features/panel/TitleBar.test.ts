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

  it('makes the native dots accessible buttons in close/minimize/maximize order', async () => {
    const { api, state } = windowApi();
    const bar = TitleBar({ ...props, nativeWindow: api });
    const buttons = bar.props.children[0].props.children;
    expect(buttons.map((b: { props: { 'aria-label': string } }) => b.props['aria-label'])).toEqual([
      'Close window', 'Minimize window', 'Maximize or restore window',
    ]);
    expect(renderToStaticMarkup(bar)).not.toContain('class="titlebar__dots" aria-hidden');
    for (const b of buttons) expect(b.props.type).toBe('button');
    await buttons[0].props.onClick();
    expect(state).toEqual({ closed: true, minimized: false, maximized: false, drags: 0 });
    await buttons[1].props.onClick();
    expect(state.minimized).toBe(true);
    await buttons[2].props.onClick();
    expect(state.maximized).toBe(true);
    await buttons[2].props.onClick();
    expect(state.maximized).toBe(false);
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

  it.each(['button', 'a', 'input', 'textarea', 'select', '[role="button"]', '[contenteditable]:not([contenteditable="false"])', '.titlebar__task'])('does not drag or maximize from %s or its descendants', async (selector) => {
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
