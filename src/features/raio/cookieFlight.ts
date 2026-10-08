export interface CookiePoint { readonly x: number; readonly y: number; readonly diameter: number }
/** Invert the overlay's client transform, including CSS zoom/scale and app offsets. */
export const cookieLocalPoint = (point: CookiePoint, matrix: Pick<DOMMatrix, 'a' | 'b' | 'c' | 'd' | 'e' | 'f'>) => {
  const { a, b, c, d, e, f } = matrix, determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) return null;
  return { x: (d * (point.x - e) - c * (point.y - f)) / determinant, y: (a * (point.y - f) - b * (point.x - e)) / determinant, scale: point.diameter / (10 * Math.hypot(a, b)) };
};
export interface CookieTarget {
  measure(): CookiePoint | null;
  busy(): boolean;
  arrive(onFinished: () => void): boolean;
}
export interface CookieFlightPorts {
  visible(): boolean;
  reduced(): boolean;
  origin(): CookiePoint;
  target(): CookieTarget | undefined;
  overlay(): { move(point: CookiePoint): void; remove(): void };
  /** Uses the character's shared clock; never creates a second animation loop. */
  animate(step: (dt: number) => boolean): () => void;
  subscribeVisibility(listener: () => void): () => void;
}
const eio = (x: number) => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

/** One request, one target. No broadcast, queue, session state or surface navigation. */
export class CookieFlight {
  busy = false;
  private generation = 0;
  private stopAnimation?: () => void;
  private stopVisibility?: () => void;
  private overlay?: ReturnType<CookieFlightPorts['overlay']>;
  constructor(private readonly ports: CookieFlightPorts) {}
  start(): boolean {
    if (this.busy || !this.ports.visible()) return false;
    const target = this.ports.target();
    if (!target || target.busy() || !target.measure()) return false;
    const generation = ++this.generation;
    this.busy = true;
    const finish = () => { if (this.generation === generation) this.cancel(); };
    this.stopVisibility = this.ports.subscribeVisibility(() => { if (!this.ports.visible()) finish(); });
    const arrive = () => {
      this.removeFlight();
      if (!target.arrive(finish)) finish();
    };
    if (this.ports.reduced()) { arrive(); return true; }
    const origin = this.ports.origin();
    this.overlay = this.ports.overlay(); this.overlay.move(origin);
    let elapsed = 0;
    this.stopAnimation = this.ports.animate(dt => {
      const destination = target.measure();
      if (!this.ports.visible() || !destination) { finish(); return false; }
      if (this.ports.reduced()) { arrive(); return true; }
      elapsed += dt;
      const k = eio(Math.min(1, elapsed / .5));
      this.overlay?.move({ x: origin.x + (destination.x - origin.x) * k, y: origin.y + (destination.y - origin.y) * k, diameter: origin.diameter + (destination.diameter - origin.diameter) * k });
      if (elapsed + 1e-9 >= .5) arrive();
      // Even on arrival, wake one more frame: the engine may have already stepped this frame.
      return true;
    });
    return true;
  }
  private removeFlight() {
    this.stopAnimation?.(); this.stopAnimation = undefined;
    this.overlay?.remove(); this.overlay = undefined;
  }
  cancel() {
    ++this.generation;
    this.removeFlight(); this.stopVisibility?.(); this.stopVisibility = undefined;
    this.busy = false;
  }
}
