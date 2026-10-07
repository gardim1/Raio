import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useBridge } from '../../platform/BridgeContext';
import type { ConnectPreview, Connector } from '../../platform/desktopBridge';
import { Button } from '../../shared/ui/Button';
import { MiniOrb } from '../raio/MiniOrb';

/**
 * Shows only what Raio changes: the `hooks` key in full, every other value masked so secrets in
 * `env` or permission rules are not displayed (they are kept unchanged on disk).
 */
export const maskedSettings = (text: string | null): string => {
  if (text === null) return '(file does not exist)';
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '(not shown)';
    const shown = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'hooks' ? v : '… kept unchanged']));
    return JSON.stringify(shown, null, 2);
  } catch {
    return '(not valid JSON; Raio will not change it)';
  }
};

type Step = { readonly kind: 'idle' } | { readonly kind: 'review'; readonly root: string; readonly preview: ConnectPreview } | { readonly kind: 'error'; readonly message: string };

/** The same explicit before/after review for initial connection and refreshing an existing connection. */
export const ConnectReview = ({ preview, busy, onCancel, onConnect, sidebar = false }: {
  readonly preview: ConnectPreview;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConnect: () => void;
  readonly sidebar?: boolean;
}) => {
  const review = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!sidebar) return;
    const element = review.current;
    const scroller = element?.closest<HTMLElement>('.sidebar__scroll');
    if (!element || !scroller) return;
    const fit = () => {
      const style = getComputedStyle(scroller);
      const height = scroller.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      element.style.setProperty('--reconnect-max-height', `${height}px`);
      element.scrollIntoView({ block: 'start', behavior: 'instant' });
    };
    fit();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(scroller);
    return () => observer?.disconnect();
  }, [sidebar, preview]);
  return (
  <div ref={review} className={`connect connect--review${sidebar ? ' connect--sidebar-review' : ''}`}>
    <div className="connect__review-content">
    <p className="connect__title">Connect Claude Code in this project?</p>
    <p className="connect__body">
      Raio will add asynchronous hooks to <code>{preview.settingsPath}</code>. Existing settings and hooks are kept, the original is backed up, and
      Disconnect removes only Raio's entries.
    </p>
    {preview.gitIgnored === false && <p className="connect__warn">Git does not ignore this file. It contains a path on this computer; do not commit it.</p>}
    <div className="connect__diff">
      <div><span>Before</span><pre>{maskedSettings(preview.before)}</pre></div>
      <div><span>After</span><pre>{maskedSettings(preview.after)}</pre></div>
    </div>
    </div>
    <div className="connect__actions">
      <Button onClick={onCancel} disabled={busy}>Cancel</Button>
      <Button onClick={onConnect} disabled={busy}>Connect</Button>
    </div>
  </div>
  );
};

/**
 * Empty state of the native app: connect a project (opt-in, previewed, reversible) or, once connected,
 * wait for the first agent session. Nothing is written until the user confirms the exact diff.
 */
export const ConnectPanel = ({ connector }: { readonly connector: Connector }) => {
  const bridge = useBridge();
  const project = useSyncExternalStore(bridge.subscribe, connector.project, connector.project);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setStep({ kind: 'error', message: String(error) });
    } finally {
      setBusy(false);
    }
  };

  if (project && step.kind !== 'review') {
    return (
      <div className="connect">
        <MiniOrb size={22} glow={0.35} bob restartKey="connected" />
        <p className="connect__title">Connected to {project.name}</p>
        <p className="connect__body">Start a new Claude Code session in this folder. Hooks apply to sessions started after connecting.</p>
        <Button onClick={() => void run(() => connector.disconnect())} disabled={busy}>
          Disconnect
        </Button>
      </div>
    );
  }

  if (step.kind === 'review') {
    const { root, preview } = step;
    return (
      <ConnectReview preview={preview} busy={busy} onCancel={() => setStep({ kind: 'idle' })}
        onConnect={() => void run(async () => {
          await connector.connect(root, preview);
          setStep({ kind: 'idle' });
        })} />
    );
  }

  return (
    <div className="connect">
      <MiniOrb size={22} glow={0.35} bob restartKey="no-project" />
      <p className="connect__title">No project yet</p>
      <p className="connect__body">Choose a repository and connect Claude Code to it. Raio shows the exact change before writing anything.</p>
      {step.kind === 'error' && <p className="connect__warn">{step.message}</p>}
      <Button
        onClick={() =>
          void run(async () => {
            const root = await connector.chooseFolder();
            if (root) setStep({ kind: 'review', root, preview: await connector.preview(root) });
          })
        }
        disabled={busy}
      >
        Choose a folder
      </Button>
    </div>
  );
};
