/**
 * Wholesale scene-replacement detection.
 *
 * Opening a .excalidraw file (menu, Ctrl+O, drag & drop) replaces the scene
 * inside the library without any app-layer hook firing, so the linked-assets
 * verifier never re-runs and sync frames stay stale. The scene store keeps
 * object identity for unchanged elements, so a replacement is observable as
 * (almost) every element of the new scene being a fresh object — as opposed
 * to normal edits, which recreate only the touched elements.
 */

import type { ExcalidrawElement } from "@excalidraw/element/types";

/**
 * Fraction of the current scene's elements that must be new objects (or new
 * ids) compared to the previous observation for the change to count as a
 * wholesale replacement. High enough that routine edits (including
 * multi-element operations like select-all restyling) don't trigger it.
 */
const REPLACEMENT_THRESHOLD = 0.5;

export const isWholesaleSceneReplacement = (
  prev: readonly ExcalidrawElement[] | null,
  next: readonly ExcalidrawElement[],
): boolean => {
  // first observation only establishes the baseline — the initial scene is
  // covered by the one-shot verify at startup
  if (!prev) {
    return false;
  }
  if (next.length === 0) {
    return false;
  }
  const prevById = new Map(prev.map((element) => [element.id, element]));
  let replaced = 0;
  for (const element of next) {
    if (prevById.get(element.id) !== element) {
      replaced++;
    }
  }
  return replaced / next.length >= REPLACEMENT_THRESHOLD;
};
