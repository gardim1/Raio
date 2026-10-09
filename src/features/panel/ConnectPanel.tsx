import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSurfaceStore } from '../../shared/motion/visibleStore';
import { useSurfaceVisible } from '../../shared/motion/surfaceVisibility';
import { useBridge } from '../../platform/BridgeContext';
import type { ConnectPreview, Connector, UsageOptIn } from '../../platform/desktopBridge';
import { Button } from '../../shared/ui/Button';
import { MiniOrb } from '../raio/MiniOrb';
import { ConnectMapPreview, readPreviewMap, type PreviewMapState } from './ConnectMapPreview';
import { failureReason } from '../../platform/failureReason';

/**
 * Shows only what Raio changes: the `hooks` key in full, every other value masked so secrets in
 * `env` or permission rules are not displayed (they are kept unchanged on disk).
 */
export const maskedSettings = (text: string | null): string => {
  if (text === null) return '(file does not exist)';
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '(not shown)';
    const shown = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'hooks' ? v : k === 'statusLine' ? '[status line hidden]' : '… kept unchanged']));
    return JSON.stringify(shown, null, 2);
  } catch {
    return '(not valid JSON; Raio will not change it)';
  }
};

type Step = { readonly kind: 'idle' } | { readonly kind: 'loading'; readonly root: string; readonly map: PreviewMapState } | { readonly kind: 'review'; readonly root: string; readonly preview: ConnectPreview; readonly map: PreviewMapState } | { readonly kind: 'error'; readonly root?: string; readonly message: string };

/** The same explicit before/after review for initial connection and refreshing an existing connection. */
export const ConnectReview = ({ preview, busy, onCancel, onConnect, onUsageChange, usageChoice, updatingUsage = false, onRetryUsage, sidebar = false, map, mapBesideReview = false }: {
  readonly preview: ConnectPreview;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConnect: () => void;
  readonly onUsageChange?: (options: UsageOptIn) => void;
  readonly usageChoice?: UsageOptIn | null;
  readonly updatingUsage?: boolean;
  readonly onRetryUsage?: () => void;
  readonly sidebar?: boolean;
  readonly map?: PreviewMapState;
  readonly mapBesideReview?: boolean;
}) => {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const review = useRef<HTMLDivElement>(null);
  const visible = useSurfaceVisible();
  const enabled = usageChoice?.enabled ?? preview.usage?.enabled ?? false;
  const replaceExisting = usageChoice?.replaceExisting ?? preview.usage?.replaceExisting ?? false;
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
      Raio adds its hooks to <code>{preview.settingsPath}</code>; nothing else changes; Disconnect removes them.
    </p>
    {preview.gitIgnored === false && <p className="connect__warn">Git does not ignore this file. It contains a path on this computer; do not commit it.</p>}
    {map && !mapBesideReview && <ConnectMapPreview state={map} />}
    {updatingUsage && <p className="evidence__note" role="status">Updating preview…</p>}
    {onRetryUsage && <button className="connect__retry" type="button" onClick={onRetryUsage}>Retry preview</button>}
    <button className="connect__details-toggle" type="button" aria-expanded={detailsOpen} aria-controls="connect-details" onClick={() => setDetailsOpen(value => !value)}>
      {detailsOpen ? 'Hide Details' : 'Details'}
    </button>
    <div id="connect-details" className="connect__details" hidden={!detailsOpen}>
    {preview.usage && <fieldset disabled={busy}>
      <legend>Claude plan usage</legend>
      <label><input type="checkbox" checked={enabled}
        disabled={preview.usage.effective === 'managed' || preview.usage.effective === 'unavailable'}
        onChange={event => onUsageChange?.({ enabled:event.target.checked, replaceExisting:false })} /> Show Claude plan usage (5-hour and weekly limits)</label>
      <p className="connect__body">Claude Code shows Raio's empty status line row instead of some footer hints.</p>
      <p className="connect__body">{({ none:'No existing status line found.', raio:'Raio manages this project’s status line.', user:'You already have a custom Claude status line (from user settings).',
        'shared-project':'You already have a custom Claude status line (from shared project settings).', 'project-local':'You already have a custom Claude status line (from project-local settings).',
        managed:'Managed Claude settings are present.', unavailable:'The effective status line could not be inspected.' })[preview.usage.effective]}</p>
      {['user','shared-project','project-local'].includes(preview.usage.effective) && <div role="radiogroup" aria-label="Claude status line choice">
        <label><input type="radio" name="status-line-choice" checked={!replaceExisting} onChange={() => onUsageChange?.({ enabled, replaceExisting:false })} /> Keep my status line (Raio shows no plan usage)</label>
        <label><input type="radio" name="status-line-choice" checked={replaceExisting} disabled={preview.usage.effective === 'managed' || preview.usage.effective === 'unavailable'} onChange={() => onUsageChange?.({ enabled:true, replaceExisting:true })} /> Use Raio's status line in this project only</label>
      </div>}
      {preview.usage.reason && <p className="connect__warn">{preview.usage.reason}</p>}
      {preview.usage.enabled && !preview.usage.replaceExisting && ['user','shared-project','project-local'].includes(preview.usage.effective) && <p className="connect__body">Plan usage: off — keeping your status line.</p>}
      <p className="connect__body">Only this project's settings are changed. Existing status lines are not chained. A Claude Code session started with --settings may override this project setting.</p>
      <div className="connect__diff">
        <div><span>Effective source</span><pre>{preview.usage.effective === 'none' ? 'No status line' : preview.usage.effective === 'raio' ? 'Raio' : `${preview.usage.effective} settings`}</pre></div>
        <div><span>Connection result</span><pre>{preview.usage.enabled && preview.usage.replaceExisting ? 'Raio status line in this project only' : 'Existing status line kept; command hidden'}</pre></div>
      </div>
    </fieldset>}
    <div className="connect__diff">
      <div><span>Before</span><pre>{maskedSettings(preview.before)}</pre></div>
      <div><span>After</span><pre>{maskedSettings(preview.after)}</pre></div>
    </div>
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
  const [updatingUsage, setUpdatingUsage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryUsage, setRetryUsage] = useState<UsageOptIn | null>(null);
  const [usageChoice, setUsageChoice] = useState<UsageOptIn | null>(null);
  const request = useRef(0);
  const pending = useRef<{ root: string; remaining: number; usage?: UsageOptIn } | null>(initialRoot ? { root: initialRoot, remaining: 2 } : null);
  const pendingUsage = useRef<{ root:string; usage:UsageOptIn } | null>(null);
  const usageRequest = useRef(0);
  const previousInitialRoot = useRef(initialRoot);

  const begin = (root: string, usage?: UsageOptIn, preserveUsageChoice = false) => {
    onPreviewRootChange?.(root);
    const token = ++request.current;
    pending.current = { root, remaining: 2, usage };
    pendingUsage.current = null;
    if (!preserveUsageChoice) setUsageChoice(null);
    const settled = () => {
      if (token !== request.current || !pending.current) return;
      if (--pending.current.remaining === 0) pending.current = null;
    };
    setBusy(false);
    setUpdatingUsage(false);
    setError(null);
    setRetryUsage(null);
    setStep({ kind: 'loading', root, map: { kind: 'loading' } });
    // The settings diff can be reviewed while the independent read-only map scan is pending.
    void readPreviewMap(bridge, root).then((map) => {
      if (token !== request.current) return;
      setStep((current) => current.kind === 'loading' || current.kind === 'review' ? { ...current, map } : current);
    }).finally(settled);
    void (usage ? connector.preview(root, usage) : connector.preview(root)).then((preview) => {
      if (token !== request.current) return;
      setStep((current) => ({ kind: 'review', root, preview, map: current.kind === 'loading' ? current.map : { kind: 'loading' } }));
      if (preserveUsageChoice) setUsageChoice(null);
    }).catch((cause: unknown) => { if (token === request.current) setStep({ kind: 'error', root, message: failureReason(cause) ?? 'Unable to review this folder.' }); }).finally(settled);
  };
  useEffect(() => {
    if (initialRoot !== previousInitialRoot.current) {
      previousInitialRoot.current = initialRoot;
      pendingUsage.current = null;
      usageRequest.current++;
      pending.current = initialRoot ? { root: initialRoot, remaining: 2 } : null;
    }
    // Cleanup invalidates callbacks, but Activity retains the unfinished folder request for reveal.
    if (pendingUsage.current) begin(pendingUsage.current.root, pendingUsage.current.usage, true);
    else if (pending.current) begin(pending.current.root, pending.current.usage);
    return () => { request.current++; };
  }, [initialRoot, connector, bridge]);
  const cancel = () => { request.current++; pending.current = null; pendingUsage.current = null; setUsageChoice(null); setBusy(false); setStep({ kind: 'idle' }); setError(null); onPreviewRootChange?.(null); onClose?.(); };

  const run = async (action: () => Promise<void>) => {
    const token = request.current;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (error) {
      if (token === request.current) setError(failureReason(error) ?? 'Unable to complete this action.');
    } finally {
      if (token === request.current) setBusy(false);
    }
  };

  const changeUsage = (root: string, usage: UsageOptIn) => {
    const token = request.current; const choice = ++usageRequest.current;
    pendingUsage.current = { root, usage }; setUsageChoice(usage); setUpdatingUsage(true); setError(null); setRetryUsage(null);
    void connector.preview(root, usage).then(next => {
      if (token === request.current && choice === usageRequest.current) {
        pendingUsage.current = null; setRetryUsage(null); setUsageChoice(null);
        setStep(current => current.kind === 'review' && current.root === root ? { ...current, preview:next } : current);
      }
    }).catch((cause:unknown) => {
      if (token === request.current && choice === usageRequest.current) {
        pendingUsage.current = null; setRetryUsage(usage); setError(String(cause));
      }
    }).finally(() => { if (token === request.current && choice === usageRequest.current) setUpdatingUsage(false); });
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
      <ConnectReview preview={preview} map={step.map} sidebar={chooseAnother} mapBesideReview={mapBesideReview} busy={busy} usageChoice={usageChoice} updatingUsage={updatingUsage} onRetryUsage={retryUsage ? () => changeUsage(root, retryUsage) : undefined} onCancel={cancel}
        onUsageChange={usage => changeUsage(root, usage)}
        onConnect={() => void run(async () => {
          const token = request.current;
          const choice = usageRequest.current;
          const currentPreview = pendingUsage.current?.root === root ? await connector.preview(root, pendingUsage.current.usage) : preview;
          if (choice !== usageRequest.current) throw new Error('The usage choice changed. Review it, then connect again.');
          await connector.connect(root, currentPreview);
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
      <p className="connect__title">{step.kind === 'error' && step.root ? `Could not review ${step.root}` : 'No project yet'}</p>
      {step.kind === 'error' && step.root && <p className="connect__body">{step.message}</p>}
      <p className="connect__body">Choose a repository and connect Claude Code to it. Raio shows the exact change before writing anything.</p>
      {step.kind === 'error' && !step.root && <p className="connect__warn">{step.message}</p>}
      {error && <p className="connect__warn" role="alert">{error}</p>}
      {step.kind === 'error' && step.root && <Button onClick={() => begin(step.root!)}>Retry preview</Button>}
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
