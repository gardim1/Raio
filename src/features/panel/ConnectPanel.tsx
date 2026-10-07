import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSurfaceStore } from '../../shared/motion/visibleStore';
import { useSurfaceVisible } from '../../shared/motion/surfaceVisibility';
import { useBridge } from '../../platform/BridgeContext';
import type { ConnectPreview, Connector } from '../../platform/desktopBridge';
import { Button } from '../../shared/ui/Button';
import { MiniOrb } from '../raio/MiniOrb';
import { ConnectMapPreview, readPreviewMap, type PreviewMapState } from './ConnectMapPreview';

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

type Step = { readonly kind: 'idle' } | { readonly kind: 'loading'; readonly root: string; readonly map: PreviewMapState } | { readonly kind: 'review'; readonly root: string; readonly preview: ConnectPreview; readonly map: PreviewMapState } | { readonly kind: 'error'; readonly message: string };

/** The same explicit before/after review for initial connection and refreshing an existing connection. */
export const ConnectReview = ({ preview, busy, onCancel, onConnect, sidebar = false, map, mapBesideReview = false }: {
  readonly preview: ConnectPreview;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConnect: () => void;
  readonly sidebar?: boolean;
  readonly map?: PreviewMapState;
  readonly mapBesideReview?: boolean;
}) => {
  const review = useRef<HTMLDivElement>(null);
  const visible = useSurfaceVisible();
  useLayoutEffect(() => {
    if (!sidebar || !visible) return;
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
  }, [sidebar, preview, visible]);
  const card = (
  <div ref={review} className={`connect connect--review${sidebar ? ' connect--sidebar-review' : ''}`}>
    <div className="connect__review-content">
    <p className="connect__title">Connect Claude Code in this project?</p>
    <p className="connect__body">
      Raio will add asynchronous hooks to <code>{preview.settingsPath}</code>. Existing settings and hooks are kept, the original is backed up, and
      Disconnect removes only Raio's entries.
    </p>
    {preview.gitIgnored === false && <p className="connect__warn">Git does not ignore this file. It contains a path on this computer; do not commit it.</p>}
    {map && !mapBesideReview && <ConnectMapPreview state={map} />}
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
  return mapBesideReview && map ? <div className="connect__layout">
    <div className="connect__map-column"><ConnectMapPreview state={map} /></div>
    {card}
  </div> : card;
};

/**
 * Empty state of the native app: connect a project (opt-in, previewed, reversible) or, once connected,
 * wait for the first agent session. Nothing is written until the user confirms the exact diff.
 */
export const ConnectPanel = ({ connector, initialRoot, onClose, onPreviewRootChange, mapBesideReview = false }: {
  readonly connector: Connector;
  readonly initialRoot?: string;
  readonly onClose?: () => void;
  readonly onPreviewRootChange?: (root: string | null) => void;
  readonly mapBesideReview?: boolean;
}) => {
  const bridge = useBridge();
  const project = useSurfaceStore(bridge.subscribe, connector.project);
  const [step, setStep] = useState<Step>(initialRoot ? { kind: 'loading', root: initialRoot, map: { kind: 'loading' } } : { kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const pending = useRef<{ root: string; remaining: number } | null>(initialRoot ? { root: initialRoot, remaining: 2 } : null);
  const previousInitialRoot = useRef(initialRoot);

  const begin = (root: string) => {
    onPreviewRootChange?.(root);
    const token = ++request.current;
    pending.current = { root, remaining: 2 };
    const settled = () => {
      if (token !== request.current || !pending.current) return;
      if (--pending.current.remaining === 0) pending.current = null;
    };
    setBusy(false);
    setError(null);
    setStep({ kind: 'loading', root, map: { kind: 'loading' } });
    // The settings diff can be reviewed while the independent read-only map scan is pending.
    void readPreviewMap(bridge, root).then((map) => {
      if (token !== request.current) return;
      setStep((current) => current.kind === 'loading' || current.kind === 'review' ? { ...current, map } : current);
    }).finally(settled);
    void connector.preview(root).then((preview) => {
      if (token !== request.current) return;
      setStep((current) => ({ kind: 'review', root, preview, map: current.kind === 'loading' ? current.map : { kind: 'loading' } }));
    }).catch((cause: unknown) => { if (token === request.current) setStep({ kind: 'error', message: String(cause) }); }).finally(settled);
  };
  useEffect(() => {
    if (initialRoot !== previousInitialRoot.current) {
      previousInitialRoot.current = initialRoot;
      pending.current = initialRoot ? { root: initialRoot, remaining: 2 } : null;
    }
    // Cleanup invalidates callbacks, but Activity retains the unfinished folder request for reveal.
    if (pending.current) begin(pending.current.root);
    return () => { request.current++; };
  }, [initialRoot, connector, bridge]);
  const cancel = () => { request.current++; pending.current = null; setBusy(false); setStep({ kind: 'idle' }); setError(null); onPreviewRootChange?.(null); onClose?.(); };

  const run = async (action: () => Promise<void>) => {
    const token = request.current;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (error) {
      if (token === request.current) setError(String(error));
    } finally {
      if (token === request.current) setBusy(false);
    }
  };

  if (project && !initialRoot && step.kind === 'idle') {
    return (
      <div className="connect">
        <MiniOrb size={22} glow={0.35} bob restartKey="connected" />
        <p className="connect__title">Connected to {project.name}</p>
        <p className="connect__body">Start a new Claude Code session in this folder. Hooks apply to sessions started after connecting.</p>
        {error && <p className="connect__warn" role="alert">{error}</p>}
        <Button onClick={() => void run(() => connector.disconnect())} disabled={busy}>
          Disconnect
        </Button>
      </div>
    );
  }

  if (step.kind === 'loading') return <div className="connect connect--review">
    <p className="connect__title">Reviewing {step.root}</p>
    <ConnectMapPreview state={step.map} />
    <p className="evidence__note">Loading settings preview…</p>
    <Button onClick={cancel}>Cancel</Button>
  </div>;

  if (step.kind === 'review') {
    const { root, preview } = step;
    return (
      <div className="connect__flow">
      {error && <p className="connect__warn" role="alert">{error}</p>}
      <ConnectReview preview={preview} map={step.map} mapBesideReview={mapBesideReview} busy={busy} onCancel={cancel}
        onConnect={() => void run(async () => {
          const token = request.current;
          await connector.connect(root, preview);
          if (token === request.current) { pending.current = null; setStep({ kind: 'idle' }); onPreviewRootChange?.(null); onClose?.(); }
        })} />
      </div>
    );
  }

  return (
    <div className="connect">
      <MiniOrb size={22} glow={0.35} bob restartKey="no-project" />
      <p className="connect__title">No project yet</p>
      <p className="connect__body">Choose a repository and connect Claude Code to it. Raio shows the exact change before writing anything.</p>
      {step.kind === 'error' && <p className="connect__warn">{step.message}</p>}
      {error && <p className="connect__warn" role="alert">{error}</p>}
      {initialRoot && <Button onClick={cancel}>Cancel</Button>}
      <Button
        onClick={() =>
          void run(async () => {
            const token = request.current;
            const root = await connector.chooseFolder();
            if (root && token === request.current) begin(root);
          })
        }
        disabled={busy}
      >
        Choose a folder
      </Button>
    </div>
  );
};
