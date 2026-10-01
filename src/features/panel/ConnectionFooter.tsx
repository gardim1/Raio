import { useState, useSyncExternalStore } from 'react';
import { useBridge } from '../../platform/BridgeContext';
import type { Connector } from '../../platform/desktopBridge';

/** "Connected to <project> · Disconnect" at the end of the sidebar (native only). */
export const ConnectionFooter = ({ connector }: { readonly connector: Connector }) => {
  const bridge = useBridge();
  const project = useSyncExternalStore(bridge.subscribe, connector.project);
  const [busy, setBusy] = useState(false);
  if (!project) return null;
  return (
    <p className="evidence__note">
      Connected to {project.name} ·{' '}
      <button
        type="button"
        className="link-btn"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void connector.disconnect().finally(() => setBusy(false));
        }}
      >
        Disconnect
      </button>
    </p>
  );
};
