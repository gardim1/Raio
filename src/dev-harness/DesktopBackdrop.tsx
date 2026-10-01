/** A faint editor silhouette so Island and Mini read as overlays on a real desktop. */
export const DesktopBackdrop = () => (
  <div className="desktop" aria-hidden>
    <div className="desktop__editor">
      <div className="desktop__tabs">
        <i />
        <i />
        <i />
      </div>
      {Array.from({ length: 22 }, (_, i) => (
        <div key={i} className="desktop__line" style={{ width: `${20 + ((i * 37) % 55)}%`, marginLeft: `${(i % 4) * 18}px` }} />
      ))}
    </div>
  </div>
);
