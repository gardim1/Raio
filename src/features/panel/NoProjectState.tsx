import { Button } from '../../shared/ui/Button';
import { MiniOrb } from '../raio/MiniOrb';

/** Empty map: no repository detected yet. Raio sleeps; one clear action. */
export const NoProjectState = ({ onChoose }: { readonly onChoose?: () => void }) => (
  <div className="no-project">
    <MiniOrb size={22} glow={0.35} bob />
    <p className="no-project__title">No project yet</p>
    <p className="no-project__body">Open a repository, or start Claude Code or Codex inside one, and Raio will map it.</p>
    <Button onClick={onChoose}>Choose a folder</Button>
  </div>
);
