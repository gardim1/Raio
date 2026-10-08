/**
 * Legacy timing exports still used by companion recency. Preserve the 30 s activity window.
 * The character no longer draws a CSS float; its shared SVG engine stops at rest.
 */
export const BOB_PERIOD_SECONDS = 3;
export const BOB_ITERATIONS = 10;
export const BOB_TOTAL_SECONDS = BOB_PERIOD_SECONDS * BOB_ITERATIONS;
