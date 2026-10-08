import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSurfaceStore } from '../../shared/motion/visibleStore';
import { useSurfaceVisible } from '../../shared/motion/surfaceVisibility';
import { useBridge } from '../../platform/BridgeContext';
import type { ConnectPreview, Connector, UsageOptIn } from '../../platform/desktopBridge';
import { Button } from '../../shared/ui/Button';
import { MiniOrb } from '../raio/MiniOrb';
import { ConnectMapPreview, readPreviewMap, type PreviewMapState } from './ConnectMapPreview';

/**
 * Shows only what Raio changes: the `hooks` key in full, every other value masked so secrets in
 * `env` or permission rules are not displayed (they are kept unchanged on disk).
 */
export const maskedSettings = (text: string | null, statusLineInUsageDiff = false): string => {
  if (text === null) return '(file does not exist)';
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '(not shown)';
    const shown = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'hooks' ? v : k === 'statusLine' && statusLineInUsageDiff ? '… shown in Claude plan usage diff' : '… kept unchanged']));
    return JSON.stringify(shown, null, 2);
  } catch {
    return '(not valid JSON; Raio will not change it)';
  }
};

type Step = { readonly kind: 'idle' } | { readonly kind: 'loading'; readonly root: string; readonly map: PreviewMapState } | { readonly kind: 'review'; readonly root: string; readonly preview: ConnectPreview; readonly map: PreviewMapState } | { readonly kind: 'error'; readonly message: string };

/** The same explicit before/after review for initial connection and refreshing an existing connection. */
export const ConnectReview = ({ preview, busy, onCancel, onConnect, onUsageChange, sidebar = false, map, mapBesideReview = false }: {
  readonly preview: ConnectPreview;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConnect: () => void;
  readonly onUsageChange?: (options: UsageOptIn) => void;
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
    {preview.usage && <fieldset disabled={busy}>
      <legend>Claude plan usage</legend>
      <label><input type="checkbox" checked={preview.usage.enabled}
        disabled={!preview.usage.enabled && (preview.usage.effective === 'managed' || preview.usage.effective === 'unavailable')}
        onChange={event => onUsageChange?.({ enabled:event.target.checked, replaceExisting:false })} /> Show Claude plan usage (5-hour and weekly limits)</label>
      <p className="connect__body">Claude Code shows Raio's empty status line row instead of some footer hints.</p>
      <p className="connect__body">{({ none:'No existing status line found.', raio:'Raio manages this project’s status line.', user:'An existing status line comes from user settings.',
        'shared-project':'An existing status line comes from shared project settings.', 'project-local':'An existing status line comes from project-local settings.',
        managed:'Managed Claude settings are present.', unavailable:'The effective status line could not be inspected.' })[preview.usage.effective]}</p>
      {['user','shared-project','project-local'].includes(preview.usage.effective) && <label><input type="checkbox" checked={preview.usage.replaceExisting} disabled={!preview.usage.enabled}
        onChange={event => onUsageChange?.({ enabled:preview.usage!.enabled, replaceExisting:event.target.checked })} /> Replace it in this project only</label>}
      {preview.usage.reason && <p className="connect__warn">{preview.usage.reason}</p>}
      <p className="connect__body">Only this project's settings are changed. Existing status lines are not chained. A Claude Code session started with --settings may override this project setting.</p>
      <div className="connect__diff">
        <div><span>statusLine before</span><pre>{JSON.stringify(preview.usage.before, null, 2)}</pre></div>
        <div><span>statusLine after</span><pre>{JSON.stringify(preview.usage.after, null, 2)}</pre></div>
      </div>
    </fieldset>}
    <div className="connect__diff">
      <div><span>Before</span><pre>{maskedSettings(preview.before, Boolean(preview.usage))}</pre></div>
      <div><span>After</span><pre>{maskedSettings(preview.after, Boolean(preview.usage))}</pre></div>
    </div>
    </div>
    <div className="connect__actions">
      <Button onClick={onCancel} disabled={busy}>Cancel</Button>
      <Button onClick={onConnect} disabled={busy || Boolean(preview.usage?.enabled && preview.usage.reason)}>Connect</Button>
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
export const ConnectPanel = ({ connector, initialRoot, onClose, onPreviewRootChange, mapBesideReview = false, chooseAnother = false }: {
  readonly connector: Connector;
  readonly initialRoot?: string;
  readonly onClose?: () => void;
  readonly onPreviewRootChange?: (root: string | null) => void;
  readonly mapBesideReview?: boolean;
  readonly chooseAnother?: boolean;
}) => {
  const bridge = useBridge();
  const project = useSurfaceStore(bridge.subscribe, connector.project);
  const [step, setStep] = useState<Step>(initialRoot ? { kind: 'loading', root: initialRoot, map: { kind: 'loading' } } : { kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const pending = useRef<{ root: string; remaining: number; usage?: UsageOptIn } | null>(initialRoot ? { root: initialRoot, remaining: 2 } : null);
  const pendingUsage = useRef<{ root:string; usage:UsageOptIn } | null>(null);
  const usageRequest = useRef(0);
  const previousInitialRoot = useRef(initialRoot);

  const begin = (root: string, usage?: UsageOptIn) => {
    onPreviewRootChange?.(root);
    const token = ++request.current;
    pending.current = { root, remaining: 2, usage };
    pendingUsage.current = null;
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
    void (usage ? connector.preview(root, usage) : connector.preview(root)).then((preview) => {
      if (token !== request.current) return;
      setStep((current) => ({ kind: 'review', root, preview, map: current.kind === 'loading' ? current.map : { kind: 'loading' } }));
    }).catch((cause: unknown) => { if (token === request.current) setStep({ kind: 'error', message: String(cause) }); }).finally(settled);
  };
  useEffect(() => {
    if (initialRoot !== previousInitialRoot.current) {
      previousInitialRoot.current = initialRoot;
      pendingUsage.current = null;
      usageRequest.current++;
      pending.current = initialRoot ? { root: initialRoot, remaining: 2 } : null;
    }
    // Cleanup invalidates callbacks, but Activity retains the unfinished folder request for reveal.
    if (pendingUsage.current) begin(pendingUsage.current.root, pendingUsage.current.usage);
    else if (pending.current) begin(pending.current.root, pending.current.usage);
    return () => { request.current++; };
  }, [initialRoot, connector, bridge]);
  const cancel = () => { request.current++; pending.current = null; pendingUsage.current = null; setBusy(false); setStep({ kind: 'idle' }); setError(null); onPreviewRootChange?.(null); onClose?.(); };

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

  const choose = () => void run(async () => {
    const token = request.current;
    const root = await connector.chooseFolder();
    if (root && token === request.current) begin(root);
  });

  if (project && !initialRoot && step.kind === 'idle' && !chooseAnother) {
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

  if (step.kind === 'loading') return <div className={`connect connect--review${chooseAnother ? ' connect--sidebar-review' : ''}`}>
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
      <ConnectReview preview={preview} map={step.map} sidebar={chooseAnother} mapBesideReview={mapBesideReview} busy={busy} onCancel={cancel}
        onUsageChange={usage => {
          const token = request.current; const choice = ++usageRequest.current;
          pendingUsage.current = { root, usage }; setBusy(true); setError(null);
          void connector.preview(root, usage).then(next => {
            if (token === request.current && choice === usageRequest.current) {
              pendingUsage.current = null;
              setStep(current => current.kind === 'review' && current.root === root ? { ...current, preview:next } : current);
            }
          }).catch((cause:unknown) => {
            if (token === request.current && choice === usageRequest.current) {
              pendingUsage.current = null; setError(String(cause));
              // Retire the old diff after an unsuccessful choice; it must not remain applicable.
              setStep({ kind:'error', message:'Could not review the usage choice. Choose the folder again.' });
            }
          }).finally(() => { if (token === request.current && choice === usageRequest.current) setBusy(false); });
        }}
        onConnect={() => void run(async () => {
          const token = request.current;
          await connector.connect(root, preview);
          if (token === request.current) { pending.current = null; setStep({ kind: 'idle' }); onPreviewRootChange?.(null); onClose?.(); }
        })} />
      </div>
    );
  }

  if (chooseAnother) return <div className="sidebar__choose">
    {step.kind === 'error' && <p className="connect__warn" role="alert">{step.message}</p>}
    {error && <p className="connect__warn" role="alert">{error}</p>}
    <Button onClick={choose} disabled={busy}>Choose another folder</Button>
  </div>;

  return (
    <div className="connect">
      <MiniOrb size={22} glow={0.35} bob restartKey="no-project" />
      <p className="connect__title">No project yet</p>
      <p className="connect__body">Choose a repository and connect Claude Code to it. Raio shows the exact change before writing anything.</p>
      {step.kind === 'error' && <p className="connect__warn">{step.message}</p>}
      {error && <p className="connect__warn" role="alert">{error}</p>}
      {initialRoot && <Button onClick={cancel}>Cancel</Button>}
      <Button
        onClick={choose}
        disabled={busy}
      >
        Choose a folder
      </Button>
    </div>
  );
};
