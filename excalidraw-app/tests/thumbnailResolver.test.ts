/**
 * @vitest-environment jsdom
 *
 * Unit tests for the image-cache thumbnail resolver (app layer): decides
 * whether the render cache decodes a thumbnail (and at which size) or the
 * full-resolution image.
 *
 * The thumbnail store is mocked; the resolver's own branching is real.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createThumbnailResolver } from "../linkedAssets/thumbnailResolver";

// in-memory idb-keyval — folderRegistry (imported transitively via
// originals.ts) opens a store at module scope; jsdom has no indexedDB
vi.mock("idb-keyval", () => {
  const stores = new Map<string, Map<string, any>>();
  return {
    createStore: (db: string, store: string) => {
      const key = `${db}/${store}`;
      if (!stores.has(key)) {
        stores.set(key, new Map());
      }
      return key;
    },
    get: async (key: string, store: string) => stores.get(store)?.get(key),
    set: async (key: string, value: any, store: string) => {
      stores.get(store)?.set(key, value);
    },
    del: async (key: string, store: string) => {
      stores.get(store)?.delete(key);
    },
    keys: async (store: string) => [...(stores.get(store)?.keys() ?? [])],
    entries: async (store: string) => [...(stores.get(store)?.entries() ?? [])],
  };
});

const getStoredThumbnailMock = vi.fn();
const enqueueMock = vi.fn();
vi.mock("../linkedAssets/thumbnailStore", () => ({
  resolveStoredThumbnail: (...args: any[]) => getStoredThumbnailMock(...args),
  enqueueThumbnailGeneration: (...args: any[]) => enqueueMock(...args),
}));

const makeAPI = (elements: any[]) =>
  ({ getSceneElements: () => elements } as any);

const fileData = (mimeType = "image/png") =>
  ({
    id: "f1",
    mimeType,
    dataURL: "data:image/png;base64,AAAA",
    created: 0,
  } as any);

const linkedElement = (linkedFile: Record<string, any>) => ({
  type: "image",
  fileId: "f1",
  isDeleted: false,
  customData: { linkedFile },
});

const baseMeta = {
  folderId: "dir",
  relPath: "a.png",
  fileSize: 10,
  mimeType: "image/png",
  displayName: "a.png",
  status: "ok",
};

describe("createThumbnailResolver", () => {
  beforeEach(() => {
    getStoredThumbnailMock.mockReset();
    enqueueMock.mockClear();
  });

  it("serves linked images from their embedded thumbnail + meta dims", async () => {
    const api = makeAPI([
      linkedElement({ ...baseMeta, width: 4000, height: 3000 }),
    ]);
    const resolver = createThumbnailResolver(api);
    await expect(
      resolver("f1" as any, fileData(), { maxDisplayPx: 512 }),
    ).resolves.toEqual({
      dataURL: "data:image/png;base64,AAAA",
      originalWidth: 4000,
      originalHeight: 3000,
    });
    expect(getStoredThumbnailMock).not.toHaveBeenCalled();
  });

  it("falls back to null for legacy linked images without dims", async () => {
    const api = makeAPI([linkedElement(baseMeta)]);
    const resolver = createThumbnailResolver(api);
    await expect(
      resolver("f1" as any, fileData(), { maxDisplayPx: 512 }),
    ).resolves.toBeNull();
  });

  it("never thumbnails svg or gif files", async () => {
    const resolver = createThumbnailResolver(makeAPI([]));
    await expect(
      resolver("f1" as any, fileData("image/svg+xml"), {}),
    ).resolves.toBeNull();
    await expect(
      resolver("f1" as any, fileData("image/gif"), {}),
    ).resolves.toBeNull();
    expect(getStoredThumbnailMock).not.toHaveBeenCalled();
  });

  it("serves embedded images from the tier store", async () => {
    getStoredThumbnailMock.mockResolvedValue({
      dataURL: "data:image/webp;base64,t512",
      originalWidth: 3000,
      originalHeight: 2000,
    });
    const resolver = createThumbnailResolver(makeAPI([]));
    await expect(
      resolver("f1" as any, fileData(), { maxDisplayPx: 500 }),
    ).resolves.toEqual({
      dataURL: "data:image/webp;base64,t512",
      originalWidth: 3000,
      originalHeight: 2000,
    });
    expect(getStoredThumbnailMock).toHaveBeenCalledWith("f1", 500);
  });

  it("enqueues background generation on a store miss", async () => {
    getStoredThumbnailMock.mockResolvedValue(null);
    const resolver = createThumbnailResolver(makeAPI([]));
    await expect(
      resolver("f1" as any, fileData(), { maxDisplayPx: 500 }),
    ).resolves.toBeNull();
    expect(enqueueMock).toHaveBeenCalledWith(
      "f1",
      "data:image/png;base64,AAAA",
    );
  });
});
