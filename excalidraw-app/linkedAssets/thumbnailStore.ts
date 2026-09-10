/**
 * Persistent thumbnail store for the render cache: fileId → tiered webp
 * thumbnails + the original image's dimensions, in a dedicated IndexedDB
 * store. Inserted (embedded) image fileIds are content hashes, so entries
 * are shared across scenes and sessions.
 *
 * A small in-module background queue generates tiers off the idle path
 * (concurrency 2) so bulk image insertion never blocks interaction.
 * Entries are LRU-evicted past THUMBNAIL_STORE_LIMIT.
 */

import { createStore, del, entries, get, keys, set } from "idb-keyval";

import type { DataURL } from "@excalidraw/excalidraw/types";

import { STORAGE_KEYS } from "../app_constants";

import { generateThumbnailTiers, pickThumbnailTier } from "./thumbnail";

import type { ThumbnailTier } from "./thumbnail";

/** soft cap of stored thumbnail entries; LRU eviction past it */
export const THUMBNAIL_STORE_LIMIT = 3000;

export interface StoredThumbnails {
  tiers: Partial<Record<ThumbnailTier, DataURL>>;
  /** full-resolution dimensions of the source image */
  originalWidth: number;
  originalHeight: number;
  /** epoch ms, for LRU eviction */
  lastAccess: number;
}

const thumbnailStore = createStore(
  STORAGE_KEYS.IDB_THUMBNAILS_DB,
  STORAGE_KEYS.IDB_THUMBNAILS_STORE,
);

/**
 * Looks up stored thumbnails for `fileId` and picks the smallest tier
 * covering `neededPx` (device px). Returns null on a miss. Touches the
 * entry for LRU. Never throws — IDB may be unavailable (private mode).
 */
export const resolveStoredThumbnail = async (
  fileId: string,
  neededPx: number,
): Promise<{
  dataURL: DataURL;
  originalWidth: number;
  originalHeight: number;
} | null> => {
  try {
    const entry = await get<StoredThumbnails>(fileId, thumbnailStore);
    if (!entry) {
      return null;
    }
    const tier = pickThumbnailTier(
      Object.keys(entry.tiers).map(Number),
      neededPx,
    );
    const dataURL =
      tier === null ? undefined : entry.tiers[tier as ThumbnailTier];
    if (!dataURL) {
      return null;
    }
    // touch for LRU, fire-and-forget
    void set(
      fileId,
      { ...entry, lastAccess: Date.now() },
      thumbnailStore,
    ).catch(() => {});
    return {
      dataURL,
      originalWidth: entry.originalWidth,
      originalHeight: entry.originalHeight,
    };
  } catch {
    return null;
  }
};

const evictIfNeeded = async (): Promise<void> => {
  try {
    const allKeys = await keys(thumbnailStore);
    if (allKeys.length <= THUMBNAIL_STORE_LIMIT) {
      return;
    }
    const all = await entries<string, StoredThumbnails>(thumbnailStore);
    all.sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    // evict down to the limit, plus a small margin so the next put doesn't
    // immediately trigger another full scan
    const toRemove = all.slice(
      0,
      all.length -
        THUMBNAIL_STORE_LIMIT +
        Math.floor(THUMBNAIL_STORE_LIMIT / 10),
    );
    await Promise.all(toRemove.map(([key]) => del(key, thumbnailStore)));
  } catch (error) {
    console.warn("thumbnail store eviction failed", error);
  }
};

export const putStoredThumbnails = async (
  fileId: string,
  value: {
    tiers: Partial<Record<ThumbnailTier, DataURL>>;
    originalWidth: number;
    originalHeight: number;
  },
): Promise<void> => {
  if (!Object.keys(value.tiers).length) {
    // image smaller than every tier — nothing worth storing
    return;
  }
  try {
    const stored: StoredThumbnails = { ...value, lastAccess: Date.now() };
    await set(fileId, stored, thumbnailStore);
    void evictIfNeeded();
  } catch (error) {
    console.warn("failed to store thumbnails", error);
  }
};

// ---------------------------------------------------------------------------
// background generation queue
// ---------------------------------------------------------------------------

const QUEUE_CONCURRENCY = 2;

const queue: Array<{ fileId: string; dataURL: DataURL }> = [];
const queuedIds = new Set<string>();
let inFlight = 0;
let pumpScheduled = false;

const requestIdle = (cb: () => void): void => {
  if (
    typeof window !== "undefined" &&
    typeof window.requestIdleCallback === "function"
  ) {
    window.requestIdleCallback(cb, { timeout: 2000 });
  } else {
    setTimeout(cb, 50);
  }
};

const runJob = (job: { fileId: string; dataURL: DataURL }): void => {
  inFlight++;
  generateThumbnailTiers(job.dataURL)
    .then(({ tiers, originalWidth, originalHeight }) =>
      putStoredThumbnails(job.fileId, {
        tiers,
        originalWidth,
        originalHeight,
      }),
    )
    .catch((error) => {
      console.warn("background thumbnail generation failed", error);
    })
    .finally(() => {
      inFlight--;
      if (queue.length && !pumpScheduled) {
        schedulePump();
      }
    });
};

const pump = (): void => {
  pumpScheduled = false;
  while (inFlight < QUEUE_CONCURRENCY && queue.length) {
    const job = queue.shift()!;
    queuedIds.delete(job.fileId);
    runJob(job);
  }
};

const schedulePump = (): void => {
  pumpScheduled = true;
  requestIdle(pump);
};

/**
 * Enqueues background tier generation for `fileId` (deduped). Fire and
 * forget: failures only mean the render cache keeps decoding the original.
 */
export const enqueueThumbnailGeneration = (
  fileId: string,
  dataURL: DataURL,
): void => {
  if (queuedIds.has(fileId)) {
    return;
  }
  queuedIds.add(fileId);
  queue.push({ fileId, dataURL });
  if (!pumpScheduled) {
    schedulePump();
  }
};

/** test-only: drains the queue and resets its state */
export const _clearThumbnailQueueForTests = (): void => {
  queue.length = 0;
  queuedIds.clear();
};
