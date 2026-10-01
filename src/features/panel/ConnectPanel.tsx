import { useState, useSyncExternalStore } from 'react';
import { useBridge } from '../../platform/BridgeContext';
import type { ConnectPreview, Connector } from '../../platform/desktopBridge';
import { Button } from '../../shared/ui/Button';
import { MiniOrb } from '../raio/MiniOrb';

type Step = { readonly kind: 'idle' } | { readonly kind: 'review'; readonly root: string; readonly preview: ConnectPreview } | { readonly kind: 'error'; readonly message: string };


/**
 * Empty state of the native app: connect a project (opt-in, previewed, reversible) or, once connected,
 * wait for the first agent session. Nothing is written until the user confirms the exact diff.
 */
export const ConnectPanel = ({ connector }: { readonly connector: Connector }) => {
  const bridge = useBridge();
  const project = useSyncExternalStore(bridge.subscribe, connector.project);
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
        <MiniOrb size={22} glow={0.35} bob />
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
      <div className="connect connect--review">
        <p className="connect__title">Connect Claude Code in this project?</p>
        <p className="connect__body">
          Raio will add asynchronous hooks to <code>{preview.settingsPath}</code>. Existing settings and hooks are kept, the original is backed up, and
          Disconnect removes only Raio's entries.
        </p>
        {preview.gitIgnored === false && <p className="connect__warn">Git does not ignore this file. It contains a path on this computer; do not commit it.</p>}
        <div className="connect__diff">
          <div>
            <span>Before</span>
            <pre>{preview.before ?? '(file does not exist)'}</pre>
          </div>
          <div>
            <span>After</span>
            <pre>{preview.after}</pre>
          </div>
        </div>
        <div className="connect__actions">
          <Button onClick={() => setStep({ kind: 'idle' })} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              void run(async () => {
                await connector.connect(root, preview);
                setStep({ kind: 'idle' });
              })
            }
            disabled={busy}
          >
            Connect
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="connect">
      <MiniOrb size={22} glow={0.35} bob />
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
