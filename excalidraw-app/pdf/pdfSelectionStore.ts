/**
 * Tiny external store feeding the pdf toolbar host: App.tsx publishes the
 * current selection on every onChange; the toolbar subscribes via
 * useSyncExternalStore and only re-renders when the single-selected pdf
 * element (or the viewport bits used for positioning) actually changes.
 */

import { isPdfElement } from "@excalidraw/element";

import type { ExcalidrawPdfElement } from "@excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/element/types";

export interface PdfToolbarSnapshot {
  element: ExcalidrawPdfElement | null;
  scrollX: number;
  scrollY: number;
  zoom: number;
}

const EMPTY: PdfToolbarSnapshot = {
  element: null,
  scrollX: 0,
  scrollY: 0,
  zoom: 1,
};

let snapshot: PdfToolbarSnapshot = EMPTY;
const listeners = new Set<() => void>();

export const publishPdfSelection = (
  elements: readonly OrderedExcalidrawElement[],
  appState: AppState,
): void => {
  let pdfElement: ExcalidrawPdfElement | null = null;
  let selectedCount = 0;
  for (const element of elements) {
    if (element.isDeleted || !appState.selectedElementIds[element.id]) {
      continue;
    }
    selectedCount++;
    if (selectedCount === 1 && isPdfElement(element)) {
      pdfElement = element;
    } else {
      pdfElement = null;
    }
  }
  if (selectedCount !== 1) {
    pdfElement = null;
  }

  const { scrollX, scrollY, zoom } = appState;
  if (
    snapshot.element === pdfElement &&
    snapshot.scrollX === scrollX &&
    snapshot.scrollY === scrollY &&
    snapshot.zoom === zoom.value
  ) {
    return;
  }
  snapshot = pdfElement
    ? { element: pdfElement, scrollX, scrollY, zoom: zoom.value }
    : scrollX === 0 && scrollY === 0 && zoom.value === 1
    ? EMPTY
    : { element: null, scrollX, scrollY, zoom: zoom.value };
  for (const listener of Array.from(listeners)) {
    listener();
  }
};

export const subscribePdfSelection = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getPdfSelectionSnapshot = (): PdfToolbarSnapshot => snapshot;
