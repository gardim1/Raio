import { AGENT_LABEL } from '../../features/session/model/events';
import type { AgentId } from '../../features/session/model/script';

/** Product name of each agent as shown in headings ("Claude Code", "Codex") — never suffixed by hand. */
const AGENT_FULL_NAME: Record<AgentId, string> = { claude: 'Claude Code', codex: 'Codex' };

export const agentShortName = (agent: AgentId): string => AGENT_LABEL[agent];
export const agentFullName = (agent: AgentId): string => AGENT_FULL_NAME[agent];

/** Fills the `{agent}` placeholder of a story label with the short agent name. */
export const withAgent = (label: string, agent: AgentId): string => label.replaceAll('{agent}', agentShortName(agent));
