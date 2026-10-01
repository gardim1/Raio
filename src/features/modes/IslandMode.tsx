import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { AgentStatus } from '../../shared/ui/AgentStatus';
import { Button, IconButton } from '../../shared/ui/Button';
import { ExpandIcon, PinIcon, PlayIcon } from '../../shared/ui/icons';
import { RiskPill } from '../../shared/ui/RiskPill';
import { MiniOrb } from '../raio/MiniOrb';
import { AGENT_LABEL } from '../session/model/events';
import type { FrameState } from '../session/model/evaluateFrame';
import type { ChoreographyScript } from '../session/model/script';
import { CROSSFADE, ISLAND_TRANSITION, type Presence } from './presence';

export interface IslandModeProps {
  readonly script: ChoreographyScript;
  readonly frame: FrameState;
  readonly presence: Presence;
  readonly onPinMini: () => void;
  readonly onExpand: () => void;
  readonly onViewChanges: () => void;
}

/**
 * Island Mode — a 34px capsule docked to the top edge. Hover springs it open to 384×156
 * (stiffness 420, damping 34) to reveal agent, task, area, status and any warning.
 */
export const IslandMode = ({ script, frame, presence, onPinMini, onExpand, onViewChanges }: IslandModeProps) => {
  const [open, setOpen] = useState(false);
  const { ui, orb } = frame;
  const agent = AGENT_LABEL[script.agent];
  const working = ui.status === 'working';
  const finished = ui.finished;
  const collapsedLabel = working
    ? `${agent} · ${presence.activeNodeLabel ?? 'starting'}`
    : presence.recentlyFinished
      ? `${agent} finished`
      : finished
        ? 'Idle'
        : 'Ready';
  const dotClass = working ? 'cool' : presence.recentlyFinished ? 'success' : 'idle';

  return (
    <div className="island-dock">
      <motion.div
        layoutId="raio-surface"
        layoutDependency={open}
        transition={open ? ISLAND_TRANSITION : { ...ISLAND_TRANSITION, stiffness: 520 }}
        className={`island${open ? ' island--open' : ''}`}
        style={{ borderRadius: open ? 26 : 17 }}
        onHoverStart={() => setOpen(true)}
        onHoverEnd={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOpen(false)}
        tabIndex={0}
        aria-label={`Raio: ${collapsedLabel}`}
        aria-expanded={open}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {open ? (
            <motion.div key="open" className="island__open" initial={{ opacity: 0, filter: 'blur(4px)' }} animate={{ opacity: 1, filter: 'blur(0px)', transition: { ...CROSSFADE, delay: 0.08 } }} exit={{ opacity: 0, transition: { duration: 0.12 } }}>
              <div className="island__row">
                <MiniOrb size={16} glow={0.3 + orb.glowCool * 0.6} warm={orb.glowWarm} />
                <span className="island__title">{agent} Code</span>
                <span className="island__spacer" />
                <AgentStatus state={ui.status} agent={script.agent} />
              </div>
              <div className="island__task">{script.task}</div>
              <div className="island__row island__row--meta">
                {presence.activeNodeLabel && (
                  <span className="island__area">
                    <i className={ui.activeRisk && ui.activeRisk.nodeId === ui.activeNodeId ? 'warn' : ''} />
                    {working ? 'Working in' : 'Last in'} {presence.activeNodeLabel}
                  </span>
                )}
                {ui.activeRisk && <RiskPill kind={ui.activeRisk.kind} label={ui.activeRisk.label} />}
              </div>
              <div className="island__row island__row--actions">
                {presence.cta !== 'hidden' ? (
                  <Button className={presence.cta === 'quiet' ? 'btn--quiet' : ''} icon={<PlayIcon />} onClick={onViewChanges}>
                    View changes
                  </Button>
                ) : (
                  <span className="island__hint">
                    {finished
                      ? `${script.summary.systems} systems affected, ${script.summary.reviewCount} worth reviewing`
                      : working
                        ? `Following ${agent} Code`
                        : 'Waiting for an agent'}
                  </span>
                )}
                <span className="island__spacer" />
                <IconButton label="Pin as mini player" onClick={onPinMini}>
                  <PinIcon />
                </IconButton>
                <IconButton label="Open full view" onClick={onExpand}>
                  <ExpandIcon />
                </IconButton>
              </div>
            </motion.div>
          ) : (
            <motion.div key="closed" className="island__closed" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { ...CROSSFADE, delay: 0.06 } }} exit={{ opacity: 0, transition: { duration: 0.1 } }}>
              <MiniOrb size={14} glow={0.25 + orb.glowCool * 0.6} warm={orb.glowWarm} bob={!working} />
              <span className="island__label">{collapsedLabel}</span>
              {ui.activeRisk && working ? <i className="island__dot island__dot--warning" /> : <i className={`island__dot island__dot--${dotClass}`} />}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
};
