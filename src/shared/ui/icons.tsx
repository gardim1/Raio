/** Minimal 14×14 stroke/fill icons used across Raio chrome. */
const base = { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': true } as const;

export const PlayIcon = () => (
  <svg {...base} fill="currentColor"><path d="M4 2.6v8.8a.6.6 0 0 0 .9.5l7-4.4a.6.6 0 0 0 0-1L4.9 2.1a.6.6 0 0 0-.9.5z" /></svg>
);
export const PauseIcon = () => (
  <svg {...base} fill="currentColor"><rect x="3" y="2.5" width="2.6" height="9" rx="1" /><rect x="8.4" y="2.5" width="2.6" height="9" rx="1" /></svg>
);
export const ReplayIcon = () => (
  <svg {...base} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M2.5 7a4.5 4.5 0 1 0 1.4-3.3" /><path d="M2.6 1.8v2.4H5" /></svg>
);
export const CheckIcon = () => (
  <svg {...base} fill="none"><path className="icon-check" d="M3 7.4l2.6 2.6L11 4.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
export const CrossIcon = () => (
  <svg {...base} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M4 4l6 6M10 4l-6 6" /></svg>
);
export const ExpandIcon = () => (
  <svg {...base} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8.5 2.5h3v3M5.5 11.5h-3v-3M11.5 2.5 8 6M2.5 11.5 6 8" /></svg>
);
export const CollapseIcon = () => (
  <svg {...base} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h3V2M11 9H8v3M6 5 2.5 1.5M8 9l3.5 3.5" /></svg>
);
export const PinIcon = ({ filled = false }: { readonly filled?: boolean }) => (
  <svg {...base} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"><path d="M5 1.8h4l-.6 3.6 2.1 1.9H3.5l2.1-1.9z" /><path d="M7 7.3v4.9" strokeLinecap="round" /></svg>
);
export const CloseIcon = () => (
  <svg {...base} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" /></svg>
);
export const SpinnerIcon = () => (
  <svg {...base} fill="none" className="icon-spin"><circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeOpacity=".25" strokeWidth="1.6" /><path d="M7 2.4a4.6 4.6 0 0 1 4.6 4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
);
