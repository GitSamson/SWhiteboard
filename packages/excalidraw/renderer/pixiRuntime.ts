/**
 * Runtime switch for the Pixi.js (WebGL) static-scene compositor.
 *
 * Reads `VITE_APP_ENABLE_PIXI_RENDERER` (string compare, like the other
 * feature flags) and allows a runtime override for experiments/tests.
 * When disabled, everything falls back to the Canvas 2D render path.
 */

let pixiRendererOverride: boolean | null = null;

/** overrides the env flag; pass `null` to clear the override */
export const setPixiRendererEnabled = (enabled: boolean | null): void => {
  pixiRendererOverride = enabled;
};

export const isPixiRendererEnabled = (): boolean =>
  pixiRendererOverride ??
  import.meta.env.VITE_APP_ENABLE_PIXI_RENDERER === "true";
