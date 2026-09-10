/**
 * @vitest-environment jsdom
 *
 * Unit tests for the thumbnail pipeline (stage 1 of the rendering
 * performance work): tier picking and the persistent thumbnail store
 * (LRU + background queue).
 *
 * idb-keyval is backed by in-memory maps; canvas-based tier generation is
 * mocked out (jsdom has no canvas 2d implementation).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DataURL } from "@excalidraw/excalidraw/types";

import {
  getThumbnailDimensions,
  pickThumbnailTier,
} from "../linkedAssets/thumbnail";
import {
  THUMBNAIL_STORE_LIMIT,
  _clearThumbnailQueueForTests,
  enqueueThumbnailGeneration,
  putStoredThumbnails,
  resolveStoredThumbnail,
} from "../linkedAssets/thumbnailStore";

// ---------------------------------------------------------------------------
// module mocks
// ---------------------------------------------------------------------------

// in-memory idb-keyval (vi.hoisted so the mock factory can reach it)
const { idbStores } = vi.hoisted(() => ({
  idbStores: new Map<string, Map<string, any>>(),
}));
vi.mock("idb-keyval", () => ({
  createStore: (db: string, store: string) => {
    const key = `${db}/${store}`;
    if (!idbStores.has(key)) {
      idbStores.set(key, new Map());
    }
    return key;
  },
  get: async (key: string, store: string) => idbStores.get(store)?.get(key),
  set: async (key: string, value: any, store: string) => {
    idbStores.get(store)?.set(key, value);
  },
  del: async (key: string, store: string) => {
    idbStores.get(store)?.delete(key);
  },
  keys: async (store: string) => [...(idbStores.get(store)?.keys() ?? [])],
  entries: async (store: string) => [
    ...(idbStores.get(store)?.entries() ?? []),
  ],
}));

const generatedTiers = vi.fn(async (dataURL: string) => ({
  tiers: { 256: `${dataURL}#256`, 512: `${dataURL}#512` },
  originalWidth: 800,
  originalHeight: 600,
}));
vi.mock("../linkedAssets/thumbnail", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../linkedAssets/thumbnail")
  >();
  return {
    ...original,
    generateThumbnailTiers: (dataURL: string) => generatedTiers(dataURL),
  };
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// pickThumbnailTier (pure)
// ---------------------------------------------------------------------------

describe("pickThumbnailTier", () => {
  it("returns null when no tiers exist", () => {
    expect(pickThumbnailTier([], 100)).toBeNull();
  });

  it("picks the smallest tier covering the needed size", () => {
    expect(pickThumbnailTier([256, 512, 1024], 100)).toBe(256);
    expect(pickThumbnailTier([256, 512, 1024], 256)).toBe(256);
    expect(pickThumbnailTier([256, 512, 1024], 300)).toBe(512);
    expect(pickThumbnailTier([256, 512, 1024], 900)).toBe(1024);
  });

  it("falls back to the largest tier past the top end", () => {
    expect(pickThumbnailTier([256, 512, 1024], 4000)).toBe(1024);
  });

  it("tolerates unsorted input", () => {
    expect(pickThumbnailTier([1024, 256], 100)).toBe(256);
  });
});

describe("getThumbnailDimensions", () => {
  it("never upscales", () => {
    expect(getThumbnailDimensions(100, 50)).toEqual({ width: 100, height: 50 });
  });
});

// ---------------------------------------------------------------------------
// thumbnailStore
// ---------------------------------------------------------------------------

describe("thumbnailStore", () => {
  beforeEach(() => {
    // clear the inner stores — createStore() only runs once at module load,
    // so removing outer entries would silently break later sets
    for (const store of idbStores.values()) {
      store.clear();
    }
    _clearThumbnailQueueForTests();
    generatedTiers.mockClear();
  });

  it("returns null on a store miss", async () => {
    await expect(resolveStoredThumbnail("nope", 512)).resolves.toBeNull();
  });

  it("stores tiers and resolves the fitting tier", async () => {
    await putStoredThumbnails("img1", {
      tiers: {
        256: "data:image/webp;base64,t256" as DataURL,
        512: "data:image/webp;base64,t512" as DataURL,
      },
      originalWidth: 2000,
      originalHeight: 1000,
    });

    await expect(resolveStoredThumbnail("img1", 100)).resolves.toEqual({
      dataURL: "data:image/webp;base64,t256",
      originalWidth: 2000,
      originalHeight: 1000,
    });
    await expect(resolveStoredThumbnail("img1", 400)).resolves.toEqual({
      dataURL: "data:image/webp;base64,t512",
      originalWidth: 2000,
      originalHeight: 1000,
    });
    // past the top tier → largest available
    await expect(resolveStoredThumbnail("img1", 8000)).resolves.toMatchObject({
      dataURL: "data:image/webp;base64,t512",
    });
  });

  it("ignores puts with no tiers (small images)", async () => {
    await putStoredThumbnails("small", {
      tiers: {},
      originalWidth: 100,
      originalHeight: 100,
    });
    await expect(resolveStoredThumbnail("small", 100)).resolves.toBeNull();
  });

  it("evicts least-recently-used entries past the limit", async () => {
    // fill exactly to the limit with ascending lastAccess
    for (let i = 0; i < THUMBNAIL_STORE_LIMIT; i++) {
      await putStoredThumbnails(`f${i}`, {
        tiers: { 256: `data:image/webp;base64,${i}` as DataURL },
        originalWidth: 1000,
        originalHeight: 1000,
      });
      // putStoredThumbnails stamps lastAccess with Date.now() — ensure
      // strictly increasing timestamps for a deterministic LRU order
      await sleep(1);
    }
    // touch an early entry so it survives the next eviction
    await resolveStoredThumbnail("f0", 100);
    await sleep(5);

    await putStoredThumbnails("overflow", {
      tiers: { 256: "data:image/webp;base64,x" as DataURL },
      originalWidth: 1000,
      originalHeight: 1000,
    });
    // eviction runs fire-and-forget after the put
    await vi.waitFor(() => {
      const store = [...idbStores.values()][0];
      expect(store.size).toBeLessThanOrEqual(THUMBNAIL_STORE_LIMIT);
    });

    const store = [...idbStores.values()][0];
    expect(store.has("f0")).toBe(true); // recently touched → kept
    expect(store.has("overflow")).toBe(true);
    expect(store.has("f1")).toBe(false); // oldest untouched → evicted
  }, 60000);

  it("generates tiers in the background, deduped by fileId", async () => {
    enqueueThumbnailGeneration("bg1", "data:image/png;base64,a" as DataURL);
    enqueueThumbnailGeneration("bg1", "data:image/png;base64,a" as DataURL);
    enqueueThumbnailGeneration("bg2", "data:image/png;base64,b" as DataURL);

    await vi.waitFor(() => {
      expect(generatedTiers).toHaveBeenCalledTimes(2);
    });

    await vi.waitFor(async () => {
      await expect(resolveStoredThumbnail("bg1", 100)).resolves.toMatchObject({
        dataURL: "data:image/png;base64,a#256",
        originalWidth: 800,
      });
    });
  });
});
