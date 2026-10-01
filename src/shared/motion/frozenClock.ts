/**
 * Test-only clock override. The dev harness sets it from `?t=` so screenshots are
 * deterministic; the product entry never sets it.
 */
let frozenAt: number | null = null;

export const freezeClock = (seconds: number | null): void => {
  frozenAt = seconds;
};

export const frozenClock = (): number | null => frozenAt;
