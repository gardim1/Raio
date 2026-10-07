import type { CompanionPresence } from './companionPresence';
export const PresenceHistory = ({ presence }: { readonly presence: CompanionPresence }) => presence.records.length > 0 ? (
  <section aria-label="Recorded project observations">
    <h4 className="sidebar__section">Project observations</h4>
    <ul className="evidence__list">{presence.records.map(record => (
      <li key={record.id} className={`evidence__item${record.historical ? ' presence-record--historical' : ''}`}>
        <span className="evidence__path">{record.historical && record.kind === 'attention' ? 'Earlier observation · ' : ''}{record.label}</span>
        <span className="evidence__meta">{record.source}</span>
      </li>
    ))}</ul>
  </section>
) : null;
