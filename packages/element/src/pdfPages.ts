/**
 * Bridge between the library and the app for PDF page bitmaps.
 *
 * Pdf elements render through the regular static pipeline (offscreen canvas →
 * Pixi texture); the library never decodes PDFs itself. Instead the app
 * rasterizes pages (server-side on the dev server) and registers a getter
 * here, keyed by `${fileId}:${page}`. The getter is called synchronously
 * during `drawElementOnCanvas` — a cache miss returns `null` and the element
 * renders a placeholder until the app invalidates the element's render cache
 * once the bitmap arrives. The miss handler lets the app start that fetch
 * from the render itself instead of relying on indirect scene-change events.
 */

export type PdfPageKey = string;

let pdfPageGetter: ((key: PdfPageKey) => HTMLImageElement | null) | null = null;

/** app callback fired (synchronously, during render) on a page-image miss;
 *  `hiRes` mirrors the element's `customData.sourceFile.hiRes` so the app can
 *  fetch the matching quality tier */
let pdfPageMissHandler:
  | ((fileId: string, page: number, hiRes: boolean) => void)
  | null = null;

export const setPdfPageImageGetter = (
  getter: ((key: PdfPageKey) => HTMLImageElement | null) | null,
): void => {
  pdfPageGetter = getter;
};

export const setPdfPageMissHandler = (
  handler: ((fileId: string, page: number, hiRes: boolean) => void) | null,
): void => {
  pdfPageMissHandler = handler;
};

export const getPdfPageImage = (key: PdfPageKey): HTMLImageElement | null =>
  pdfPageGetter ? pdfPageGetter(key) : null;

/** call while painting a placeholder so the app can start the fetch */
export const notifyPdfPageMiss = (
  fileId: string,
  page: number,
  hiRes = false,
): void => {
  pdfPageMissHandler?.(fileId, page, hiRes);
};

/**
 * Elements whose most recent draw painted a placeholder (page bitmap not in
 * the runtime cache). The app heals — invalidates the element's render cache
 * and forces a re-render — only while this flag is set, so heals stay
 * event-driven and flips back onto an already-cached page still recover from
 * a stale placeholder canvas.
 */
const placeholderPending = new Set<string>();

export const markPdfPlaceholderPending = (elementId: string): void => {
  if (placeholderPending.size > 1000) {
    placeholderPending.clear();
  }
  placeholderPending.add(elementId);
};

export const clearPdfPlaceholderPending = (elementId: string): void => {
  placeholderPending.delete(elementId);
};

export const isPdfPlaceholderPending = (elementId: string): boolean =>
  placeholderPending.has(elementId);

/**
 * Builds the cache key for an element's (fileId, page) pair. The hi-res tier
 * gets its own keyspace (`:hd` suffix) so SD and HD bitmaps coexist in both
 * the runtime cache and the persistent IDB store; SD keys stay unchanged so
 * caches written before the tier existed keep hitting.
 */
export const pdfPageKey = (
  fileId: string,
  page: number,
  hiRes = false,
): PdfPageKey => (hiRes ? `${fileId}:${page}:hd` : `${fileId}:${page}`);
