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
  clearPdfPlaceholderPending,
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
  setPdfPageMissHandler((fileId, page) => {
    setTimeout(() => void ensurePdfPageForFile(excalidrawAPI, fileId, page), 0);
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
  width = 1200,
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
 * Invalidate every STALE-PLACEHOLDER scene element bound to `fileId` and
 * force a re-render. Elements whose latest draw already used the page bitmap
 * are skipped (no wasteful refresh); the pending flag is how we tell.
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
      clearPdfPlaceholderPending(el.id);
      healed = true;
    }
  }
  if (healed) {
    console.info(`[pdf] ${fileId}: healed placeholder elements`);
    excalidrawAPI.refresh();
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
): Promise<void> => {
  const key = pdfPageKey(fileId, page);
  if (imageCache.has(key)) {
    // bitmap already here — but if some element still shows a placeholder
    // canvas (its heal refresh was lost earlier), heal it now
    healFile(excalidrawAPI, fileId);
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
      const dataURL = excalidrawAPI.getFiles()[fileId as FileId]?.dataURL;
      if (!dataURL) {
        // BinaryFiles may still be restoring — the next render miss retries
        console.info(`[pdf] ${key}: source file not restored yet`);
        return;
      }

      // persistent cache first: pages visited in a previous session redraw
      // instantly, no server round-trip
      const stored = await readPdfPage(key);
      if (stored) {
        console.info(`[pdf] ${key}: IDB cache hit`);
        imageCache.set(key, await blobToImage(await dataUrlToBlob(stored)));
        healFile(excalidrawAPI, fileId);
        return;
      }

      console.info(`[pdf] ${key}: fetching from server`);
      const info = await openPdfData(dataURL);
      if (page < 1 || page > info.pageCount) {
        return;
      }
      const blob = await fetchPdfPage(info.hash, page);
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
  return ensurePdfPageForFile(excalidrawAPI, sourceFile.fileId, page);
};
