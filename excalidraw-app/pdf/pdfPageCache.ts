/**
 * Client-side cache of server-rasterized PDF page bitmaps for the `pdf`
 * element type.
 *
 * Pdf elements render through the library's static pipeline; the library
 * pulls the current page bitmap synchronously via the bridge registered here
 * (`setPdfPageImageGetter`). On a miss the element shows a placeholder until
 * `ensurePdfPage()` fetches the page from the dev server
 * (POST /api/pdf-open → GET /api/pdf-page) and invalidates the element's
 * render caches, which re-renders it with the bitmap.
 */

import {
  CaptureUpdateAction,
  elementWithCanvasCache,
  isPdfPlaceholderPending,
  pdfPageKey,
  setPdfPageImageGetter,
  setPdfPageMissHandler,
  ShapeCache,
} from "@excalidraw/element";

import type { PdfPageKey } from "@excalidraw/element";
import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { blobToDataURL } from "../linkedAssets/convert";

import { readPdfPage, writePdfPage } from "./pdfPageStore";

import type { PdfSourceFileMeta } from "./pdfImport";

export interface PdfOpenPage {
  width: number;
  height: number;
}

export interface PdfOpenInfo {
  hash: string;
  pageCount: number;
  pages: PdfOpenPage[];
}

/** preview rasterization widths per quality tier (px) */
export const PREVIEW_WIDTH_SD = 1200;
export const PREVIEW_WIDTH_HD = 2400;

const imageCache = new Map<PdfPageKey, HTMLImageElement>();
const inflight = new Map<PdfPageKey, Promise<void>>();
/** /api/pdf-open results, keyed by the BinaryFiles dataURL */
const openInfoCache = new Map<string, PdfOpenInfo>();

/** wire the app cache into the library's pdf-page bridge */
export const registerPdfPageBridge = (
  excalidrawAPI: ExcalidrawImperativeAPI,
): void => {
  setPdfPageImageGetter((key) => imageCache.get(key) ?? null);
  // render-time miss → start the fetch, but DECOUPLED from the render phase:
  // launching the fetch (and the refresh it eventually triggers)
  // synchronously inside drawElementOnCanvas runs inside React's update
  // cycle and React discards updates scheduled from there ("An update was
  // scheduled from inside an update function") — which silently kills the
  // heal re-render. A macrotask detaches us completely.
  setPdfPageMissHandler((fileId, page, hiRes) => {
    setTimeout(
      () => void ensurePdfPageForFile(excalidrawAPI, fileId, page, hiRes),
      0,
    );
  });
};

/** test/diagnostic hook */
export const getCachedPdfPage = (key: PdfPageKey): HTMLImageElement | null =>
  imageCache.get(key) ?? null;

const dataUrlToBytes = async (dataURL: string): Promise<Uint8Array> => {
  const response = await fetch(dataURL);
  return new Uint8Array(await response.arrayBuffer());
};

/**
 * POST the PDF bytes to /api/pdf-open and cache the result per dataURL, so
 * re-opening a document that's already in the scene skips the parse.
 */
export const openPdfData = async (dataURL: string): Promise<PdfOpenInfo> => {
  const cached = openInfoCache.get(dataURL);
  if (cached) {
    return cached;
  }
  const bytes = await dataUrlToBytes(dataURL);
  const response = await fetch("/api/pdf-open", {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: bytes.buffer as ArrayBuffer,
  });
  if (!response.ok) {
    throw new Error(
      (await response.text()) || `pdf-open failed: ${response.status}`,
    );
  }
  const info = (await response.json()) as PdfOpenInfo;
  openInfoCache.set(dataURL, info);
  return info;
};

/** GET a single rasterized page (webp) from the dev server */
export const fetchPdfPage = async (
  hash: string,
  page: number,
  width = PREVIEW_WIDTH_SD,
): Promise<Blob> => {
  const params = new URLSearchParams({
    hash,
    page: String(page),
    width: String(width),
  });
  const response = await fetch(`/api/pdf-page?${params}`);
  if (!response.ok) {
    throw new Error(
      (await response.text()) || `pdf-page failed: ${response.status}`,
    );
  }
  return response.blob();
};

const blobToImage = (blob: Blob): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("failed to decode pdf page image"));
    };
    img.src = url;
  });

const dataUrlToBlob = async (dataURL: string): Promise<Blob> =>
  (await fetch(dataURL)).blob();

/** failed fetches back off this long before a render-triggered retry */
const RETRY_BACKOFF_MS = 30_000;
const failedAt = new Map<PdfPageKey, number>();

/**
 * Invalidate the render cache of every STALE-PLACEHOLDER scene element bound
 * to `fileId` and force a re-render. Elements whose latest draw already used
 * the page bitmap are skipped (no wasteful refresh).
 *
 * The pending flag is deliberately NOT cleared here: the heal refresh can be
 * dropped by React (update scheduled from an impure context), and if the flag
 * were cleared the element would never be retried — gray forever. The flag
 * only clears when a draw actually paints the bitmap (renderElement hit
 * branch), so a lost refresh self-heals on the next heal-loop tick.
 */
const healFile = (
  excalidrawAPI: ExcalidrawImperativeAPI,
  fileId: string,
): void => {
  let healed = false;
  for (const el of excalidrawAPI.getSceneElementsIncludingDeleted()) {
    if (
      el.customData?.sourceFile?.fileId === fileId &&
      isPdfPlaceholderPending(el.id)
    ) {
      ShapeCache.delete(el);
      elementWithCanvasCache.delete(el);
      healed = true;
    }
  }
  if (healed) {
    console.info(`[pdf] ${fileId}: healed placeholder elements`);
    // excalidrawAPI.refresh() is NOT enough here: it setStates identical
    // canvas offsets, and StaticCanvas is React.memo'd on
    // canvasNonce/elementsMap/appState — with nothing changed the memo blocks
    // the re-render, the painting effect never runs, and the invalidated
    // placeholder canvas stays on screen (gray forever after a page refresh,
    // where no other scene change ever bumps the nonce). This no-op scene
    // update bumps the scene nonce that canvasNonce derives from, forcing a
    // real repaint. captureUpdate NEVER keeps it out of undo history; the
    // resulting onChange short-circuits in the hydration handler (memory
    // hit → return, no loop), and scene-replace detection sees identical
    // element objects, so the linked-assets verifier stays quiet.
    excalidrawAPI.updateScene({
      elements: [...excalidrawAPI.getSceneElementsIncludingDeleted()],
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }
};

/**
 * Make sure the bitmap for `fileId`'s page `page` is in the cache, fetching
 * and decoding it if needed (persistent IDB cache first, dev server as
 * fallback). Safe to call repeatedly — cache hits, in-flight fetches and
 * recent failures short-circuit. Failures are logged and leave the
 * placeholder in place; the next render miss retries after a backoff.
 */
export const ensurePdfPageForFile = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
  fileId: string,
  page: number,
  hiRes = false,
): Promise<void> => {
  const key = pdfPageKey(fileId, page, hiRes);
  if (imageCache.has(key)) {
    // NOTE: no healing on the memory-hit path. This function is also called
    // from the onChange hydration chain — healing here (invalidate caches +
    // refresh) re-triggers onChange → ensure → heal → refresh, an infinite
    // loop that hits React's maximum update depth. Healing lost-refresh
    // placeholders is the heal loop's job (timer context, 1.5s spacing).
    return;
  }
  const failed = failedAt.get(key);
  if (failed && Date.now() - failed < RETRY_BACKOFF_MS) {
    return;
  }
  const pending = inflight.get(key);
  if (pending) {
    return pending;
  }

  const task = (async () => {
    try {
      // persistent cache first: pages visited in a previous session redraw
      // instantly, no server round-trip. Deliberately BEFORE the source-file
      // check — the IDB page bitmap doesn't need the PDF bytes, so this works
      // even while BinaryFiles are still restoring after a page refresh (the
      // "source file not restored yet" window that used to leave pages gray).
      const stored = await readPdfPage(key);
      if (stored) {
        console.info(`[pdf] ${key}: IDB cache hit`);
        imageCache.set(key, await blobToImage(await dataUrlToBlob(stored)));
        healFile(excalidrawAPI, fileId);
        return;
      }

      const dataURL = excalidrawAPI.getFiles()[fileId as FileId]?.dataURL;
      if (!dataURL) {
        // BinaryFiles may still be restoring — the next render miss retries
        console.info(`[pdf] ${key}: source file not restored yet`);
        return;
      }

      console.info(`[pdf] ${key}: fetching from server`);
      const info = await openPdfData(dataURL);
      if (page < 1 || page > info.pageCount) {
        return;
      }
      const blob = await fetchPdfPage(
        info.hash,
        page,
        hiRes ? PREVIEW_WIDTH_HD : PREVIEW_WIDTH_SD,
      );
      imageCache.set(key, await blobToImage(blob));
      console.info(`[pdf] ${key}: server page decoded, healing`);
      // persist for instant redraws after refresh (current + prefetched
      // adjacent pages all flow through here)
      void blobToDataURL(blob).then((pageDataURL) =>
        writePdfPage(key, pageDataURL),
      );

      healFile(excalidrawAPI, fileId);
    } catch (error) {
      console.warn(`[pdf] failed to load page ${page} of ${fileId}`, error);
      failedAt.set(key, Date.now());
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
};

/**
 * Make sure the bitmap for `element`'s page `page` is cached. Thin wrapper
 * over {@link ensurePdfPageForFile} kept for call sites that have an element
 * at hand (import, page-turn, scene-change hydration).
 */
export const ensurePdfPage = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
  element: ExcalidrawElement,
  page: number,
): Promise<void> => {
  const sourceFile = element.customData?.sourceFile as
    | PdfSourceFileMeta
    | undefined;
  if (!sourceFile?.fileId) {
    return;
  }
  return ensurePdfPageForFile(
    excalidrawAPI,
    sourceFile.fileId,
    page,
    sourceFile.hiRes === true,
  );
};

/**
 * Convergence loop of last resort: event-driven triggers (render miss,
 * scene-change hydration) cover the fast paths, but each can miss the
 * startup window exactly once — leaving the page visible at refresh stuck
 * on a placeholder forever with no further event to retrigger it. Every
 * interval tick heals any element still showing a placeholder: bitmap in
 * memory → invalidate & re-render; missing → (re)start the fetch. Once
 * everything is healed the loop is a cheap no-op scan.
 */
export const startPdfHealLoop = (
  excalidrawAPI: ExcalidrawImperativeAPI,
): (() => void) => {
  const HEAL_INTERVAL_MS = 1500;
  const timer = setInterval(() => {
    for (const el of excalidrawAPI.getSceneElementsIncludingDeleted()) {
      if (
        el.type === "pdf" &&
        !el.isDeleted &&
        isPdfPlaceholderPending(el.id)
      ) {
        const sourceFile = el.customData?.sourceFile as
          | PdfSourceFileMeta
          | undefined;
        if (sourceFile?.fileId) {
          const page = sourceFile.currentPage ?? 1;
          const hiRes = sourceFile.hiRes === true;
          if (imageCache.has(pdfPageKey(sourceFile.fileId, page, hiRes))) {
            // bitmap is cached but the element still shows a placeholder (its
            // heal repaint was lost). Heal DIRECTLY from this timer context —
            // delegating to ensurePdfPageForFile would short-circuit on the
            // memory hit without healing, leaving the page gray forever.
            healFile(excalidrawAPI, sourceFile.fileId);
          } else {
            void ensurePdfPageForFile(
              excalidrawAPI,
              sourceFile.fileId,
              page,
              hiRes,
            );
          }
        }
      }
    }
  }, HEAL_INTERVAL_MS);
  return () => clearInterval(timer);
};
