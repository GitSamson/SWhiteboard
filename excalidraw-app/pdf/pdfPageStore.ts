/**
 * Persistent disk cache of server-rasterized PDF pages (WebP dataURLs),
 * keyed by `${fileId}:${page}`. Lives in IndexedDB so a page refresh can
 * redraw pdf elements instantly instead of re-rasterizing/re-downloading
 * every page. Writes are fire-and-forget; reads never throw (IDB may be
 * unavailable, e.g. private mode) — callers fall back to the server fetch.
 */

import { createStore, del, entries, get, set } from "idb-keyval";

import type { DataURL } from "@excalidraw/excalidraw/types";

import type { PdfPageKey } from "@excalidraw/element";

import { STORAGE_KEYS } from "../app_constants";

/** soft cap of cached pages; LRU eviction past it */
export const PDF_PAGE_STORE_LIMIT = 600;

export interface StoredPdfPage {
  dataURL: DataURL;
  /** epoch ms, for LRU eviction */
  lastAccess: number;
}

const pageStore = createStore(
  STORAGE_KEYS.IDB_PDF_PAGES_DB,
  STORAGE_KEYS.IDB_PDF_PAGES_STORE,
);

/** Returns the cached page, touching it for LRU. Null on miss/unavailable. */
export const readPdfPage = async (key: PdfPageKey): Promise<DataURL | null> => {
  try {
    const stored = (await get(key, pageStore)) as StoredPdfPage | undefined;
    if (!stored) {
      return null;
    }
    void set(key, { ...stored, lastAccess: Date.now() }, pageStore).catch(
      () => {},
    );
    return stored.dataURL;
  } catch {
    return null;
  }
};

/** Cache a freshly rasterized page. Fire-and-forget. */
export const writePdfPage = (key: PdfPageKey, dataURL: DataURL): void => {
  void (async () => {
    try {
      await set(key, { dataURL, lastAccess: Date.now() }, pageStore);
      await evictIfNeeded();
    } catch (error) {
      // IDB unavailable/quota — the server cache still covers redraws, but
      // say so: a silent miss here breaks "refresh shows pages instantly"
      console.warn("[pdf] failed to persist page to IndexedDB", key, error);
    }
  })();
};

const evictIfNeeded = async (): Promise<void> => {
  const all = (await entries(pageStore)) as [PdfPageKey, StoredPdfPage][];
  if (all.length <= PDF_PAGE_STORE_LIMIT) {
    return;
  }
  // sort oldest-access first, delete the excess (leave 10% headroom)
  all.sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  const excess = all.length - Math.floor(PDF_PAGE_STORE_LIMIT * 0.9);
  for (let i = 0; i < excess; i++) {
    await del(all[i][0], pageStore);
  }
};
