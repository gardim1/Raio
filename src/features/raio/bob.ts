/**
 * The idle float plays for about 30 s after the orb's state changes, then rests still.
 * Keep in sync with `.mini-orb--bob` in raio.css (bob.test.ts checks the rule).
 */
export const BOB_PERIOD_SECONDS = 3;
export const BOB_ITERATIONS = 10;
export const BOB_TOTAL_SECONDS = BOB_PERIOD_SECONDS * BOB_ITERATIONS;
