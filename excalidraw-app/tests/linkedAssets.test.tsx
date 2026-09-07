/**
 * Unit tests for the "linked file assets" feature (app layer).
 *
 * File System Access handles and the excalidraw API are faked in-memory;
 * idb-keyval (folderRegistry) and canvas-based thumbnail generation are
 * mocked out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { sanitizeFileName } from "../linkedAssets/fsAccess";
import { getThumbnailDimensions } from "../linkedAssets/thumbnail";

import type { LinkedFileMeta, SyncFolderMeta } from "../linkedAssets/types";

// ---------------------------------------------------------------------------
// module mocks
// ---------------------------------------------------------------------------

const folderEntries = new Map<
  string,
  { handle: any; rootName: string; lastUsedAt: number }
>();

vi.mock("../linkedAssets/folderRegistry", () => ({
  getFolderEntry: async (folderId: string) => folderEntries.get(folderId),
  queryFolderPermission: async () => "granted",
  ensureFolderPermission: async () => true,
  listFolderEntries: async () => [...folderEntries.entries()],
  registerFolder: vi.fn(),
  touchFolder: vi.fn(),
  unregisterFolder: vi.fn(),
}));

vi.mock("../linkedAssets/thumbnail", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../linkedAssets/thumbnail")
  >();
  return {
    ...original,
    generateThumbnail: async () => ({
      dataURL: "data:image/webp;base64,AAAA",
      width: 100,
      height: 100,
    }),
  };
});

const importNewFilesIntoFrame = vi.fn(async (..._args: any[]) => {});
vi.mock("../linkedAssets/importer", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../linkedAssets/importer")
  >();
  return {
    ...original,
    importNewFilesIntoFrame: (api: any, frameId: any, files: any) =>
      importNewFilesIntoFrame(api, frameId, files),
  };
});

// convert.ts is imported by verifier/rename for blobToDataURL — the fake
// files aren't real Blobs, so mock it (the conversion functions aren't
// exercised by these tests)
vi.mock("../linkedAssets/convert", () => ({
  blobToDataURL: async () => "data:image/png;base64,AAAA" as const,
}));

// the feature flag env var is off in tests — force availability on
vi.mock("../linkedAssets/state", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../linkedAssets/state")
  >();
  return { ...original, isLinkedAssetsAvailable: () => true };
});

// ---------------------------------------------------------------------------
// in-memory File System Access fakes
// ---------------------------------------------------------------------------

class FakeFile {
  constructor(
    public name: string,
    public content: string,
    public type = "image/png",
  ) {}
  get size() {
    return this.content.length;
  }
}

const makeFakeDir = (files: Record<string, FakeFile>) => {
  const dir = {
    kind: "directory" as const,
    name: "root",
    async *entries(): AsyncIterableIterator<[string, any]> {
      for (const [name, file] of Object.entries(files)) {
        yield [
          name,
          {
            kind: "file",
            getFile: async () => file,
          },
        ];
      }
    },
    getFileHandle: async (name: string, opts?: { create?: boolean }) => {
      if (!files[name]) {
        if (opts?.create) {
          files[name] = new FakeFile(name, "");
        } else {
          throw new DOMException("not found", "NotFoundError");
        }
      }
      return {
        kind: "file",
        getFile: async () => files[name],
        move: async (newName: string) => {
          files[newName] = files[name];
          files[newName].name = newName;
          delete files[name];
        },
        createWritable: async () => ({
          write: async (data: any) => {
            const content =
              typeof data?.content === "string" ? data.content : String(data);
            files[name] = new FakeFile(
              name,
              content,
              typeof data?.type === "string" ? data.type : "image/png",
            );
          },
          close: vi.fn(),
        }),
      };
    },
    removeEntry: async (name: string) => {
      if (!files[name]) {
        throw new DOMException("not found", "NotFoundError");
      }
      delete files[name];
    },
  };
  return dir as unknown as FileSystemDirectoryHandle;
};

// ---------------------------------------------------------------------------
// excalidraw API fake
// ---------------------------------------------------------------------------

const makeExcalidrawAPI = (initialElements: any[]) => {
  let elements = [...initialElements];
  const api = {
    getSceneElementsIncludingDeleted: () => elements,
    getSceneElements: () => elements.filter((el) => !el.isDeleted),
    getFiles: () => ({}),
    addFiles: vi.fn(),
    updateScene: vi.fn((sceneData: any) => {
      if (sceneData.elements) {
        elements = sceneData.elements;
      }
    }),
    setToast: vi.fn(),
  };
  return api as unknown as ExcalidrawImperativeAPI & {
    updateScene: ReturnType<typeof vi.fn>;
    setToast: ReturnType<typeof vi.fn>;
  };
};

const makeImageElement = (
  id: string,
  linkedFile: Partial<LinkedFileMeta> = {},
) => ({
  id,
  type: "image",
  isDeleted: false,
  fileId: `file-${id}`,
  frameId: "frame-1",
  customData: {
    linkedFile: {
      folderId: "folder-1",
      relPath: "a.png",
      fileSize: 3,
      mimeType: "image/png",
      displayName: "a.png",
      status: "ok",
      ...linkedFile,
    } as LinkedFileMeta,
  },
});

const makeSyncFrame = (manifest: SyncFolderMeta["manifest"]) => ({
  id: "frame-1",
  type: "frame",
  isDeleted: false,
  customData: {
    syncFolder: {
      folderId: "folder-1",
      rootName: "root",
      manifest,
    } as SyncFolderMeta,
  },
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe("sanitizeFileName", () => {
  it("replaces illegal characters", () => {
    expect(sanitizeFileName('a<b>:"/\\|?*c.png')).toBe("a_b________c.png");
  });

  it("strips trailing dots and spaces", () => {
    expect(sanitizeFileName("name.png  ")).toBe("name.png");
    expect(sanitizeFileName("name...")).toBe("name");
  });

  it("falls back to untitled", () => {
    expect(sanitizeFileName("   ")).toBe("untitled");
  });
});

describe("getThumbnailDimensions", () => {
  it("scales the longest side to 512 keeping aspect", () => {
    expect(getThumbnailDimensions(2048, 1024)).toEqual({
      width: 512,
      height: 256,
    });
  });

  it("never upscales", () => {
    expect(getThumbnailDimensions(100, 50)).toEqual({ width: 100, height: 50 });
  });
});

// ---------------------------------------------------------------------------
// verifier
// ---------------------------------------------------------------------------

describe("verifier", { timeout: 20000 }, () => {
  beforeEach(() => {
    folderEntries.clear();
    importNewFilesIntoFrame.mockClear();
  });

  it("detects a rename (same size, new name) and updates the element", async () => {
    const { verifyLinkedAssets } = await import("../linkedAssets/verifier");

    const files: Record<string, FakeFile> = {
      "renamed.png": new FakeFile("renamed.png", "abc"),
    };
    folderEntries.set("folder-1", {
      handle: makeFakeDir(files),
      rootName: "root",
      lastUsedAt: 1,
    });

    const frame = makeSyncFrame({
      "a.png": { size: 3, elementIds: ["img-1"] },
    });
    const image = makeImageElement("img-1");
    const api = makeExcalidrawAPI([frame, image]);

    await verifyLinkedAssets(api);

    expect(api.updateScene).toHaveBeenCalled();
    const updated = api
      .getSceneElementsIncludingDeleted()
      .find((el) => el.id === "img-1")!;
    const meta = updated.customData!.linkedFile as LinkedFileMeta;
    expect(meta.relPath).toBe("renamed.png");
    expect(meta.displayName).toBe("renamed.png");
    expect(meta.status).toBe("ok");

    const updatedFrame = api
      .getSceneElementsIncludingDeleted()
      .find((el) => el.id === "frame-1")!;
    const manifest = (updatedFrame.customData!.syncFolder as SyncFolderMeta)
      .manifest;
    expect(manifest["renamed.png"]).toBeDefined();
    expect(manifest["a.png"]).toBeUndefined();
  });

  it("marks elements missing when the file is gone with no candidate", async () => {
    const { verifyLinkedAssets } = await import("../linkedAssets/verifier");

    folderEntries.set("folder-1", {
      handle: makeFakeDir({}),
      rootName: "root",
      lastUsedAt: 1,
    });

    const frame = makeSyncFrame({
      "a.png": { size: 3, elementIds: ["img-1"] },
    });
    const image = makeImageElement("img-1");
    const api = makeExcalidrawAPI([frame, image]);

    await verifyLinkedAssets(api);

    const updated = api
      .getSceneElementsIncludingDeleted()
      .find((el) => el.id === "img-1")!;
    expect((updated.customData!.linkedFile as LinkedFileMeta).status).toBe(
      "missing",
    );
  });

  it("refreshes thumbnails when the size changed", async () => {
    const { verifyLinkedAssets } = await import("../linkedAssets/verifier");

    const files: Record<string, FakeFile> = {
      "a.png": new FakeFile("a.png", "abcdef"),
    };
    folderEntries.set("folder-1", {
      handle: makeFakeDir(files),
      rootName: "root",
      lastUsedAt: 1,
    });

    const frame = makeSyncFrame({
      "a.png": { size: 3, elementIds: ["img-1"] },
    });
    const image = makeImageElement("img-1");
    const api = makeExcalidrawAPI([frame, image]);

    await verifyLinkedAssets(api);

    const updated = api
      .getSceneElementsIncludingDeleted()
      .find((el) => el.id === "img-1")!;
    expect((updated.customData!.linkedFile as LinkedFileMeta).fileSize).toBe(6);
  });

  it("imports new image files into the sync frame", async () => {
    const { verifyLinkedAssets } = await import("../linkedAssets/verifier");

    const files: Record<string, FakeFile> = {
      "new.png": new FakeFile("new.png", "xyz"),
    };
    folderEntries.set("folder-1", {
      handle: makeFakeDir(files),
      rootName: "root",
      lastUsedAt: 1,
    });

    const frame = makeSyncFrame({});
    const api = makeExcalidrawAPI([frame]);

    await verifyLinkedAssets(api);

    expect(importNewFilesIntoFrame).toHaveBeenCalledWith(api, "frame-1", [
      { name: "new.png", size: 3 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

describe("renameLinkedImage", { timeout: 20000 }, () => {
  beforeEach(() => {
    folderEntries.clear();
  });

  it("fails on conflict and keeps the previous name", async () => {
    const { renameLinkedImage } = await import("../linkedAssets/rename");

    const files: Record<string, FakeFile> = {
      "a.png": new FakeFile("a.png", "abc"),
      "taken.png": new FakeFile("taken.png", "def"),
    };
    folderEntries.set("folder-1", {
      handle: makeFakeDir(files),
      rootName: "root",
      lastUsedAt: 1,
    });

    const frame = makeSyncFrame({
      "a.png": { size: 3, elementIds: ["img-1"] },
    });
    const image = makeImageElement("img-1");
    const api = makeExcalidrawAPI([frame, image]);

    const result = await renameLinkedImage(api, "img-1", "taken.png");

    expect(result).toBe(false);
    expect(api.setToast).toHaveBeenCalled();
    expect(api.updateScene).not.toHaveBeenCalled();
    expect(files["a.png"]).toBeDefined();
  });

  it("renames the file on disk and updates element + manifest", async () => {
    const { renameLinkedImage } = await import("../linkedAssets/rename");

    const files: Record<string, FakeFile> = {
      "a.png": new FakeFile("a.png", "abc"),
    };
    folderEntries.set("folder-1", {
      handle: makeFakeDir(files),
      rootName: "root",
      lastUsedAt: 1,
    });

    const frame = makeSyncFrame({
      "a.png": { size: 3, elementIds: ["img-1"] },
    });
    const image = makeImageElement("img-1");
    const api = makeExcalidrawAPI([frame, image]);

    const result = await renameLinkedImage(api, "img-1", "better");

    expect(result).toBe(true);
    expect(files["better.png"]).toBeDefined();
    expect(files["a.png"]).toBeUndefined();

    const updated = api
      .getSceneElementsIncludingDeleted()
      .find((el) => el.id === "img-1")!;
    const meta = updated.customData!.linkedFile as LinkedFileMeta;
    expect(meta.relPath).toBe("better.png");
    expect(meta.displayName).toBe("better.png");

    const updatedFrame = api
      .getSceneElementsIncludingDeleted()
      .find((el) => el.id === "frame-1")!;
    const manifest = (updatedFrame.customData!.syncFolder as SyncFolderMeta)
      .manifest;
    expect(manifest["better.png"]).toBeDefined();
    expect(manifest["a.png"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// duplication
// ---------------------------------------------------------------------------

describe("duplication", { timeout: 20000 }, () => {
  beforeEach(() => {
    folderEntries.clear();
  });

  it("detects clones whose id is not in the manifest", async () => {
    const { findUnregisteredLinkedDuplicates } = await import(
      "../linkedAssets/duplicate"
    );

    const frame = makeSyncFrame({
      "a.png": { size: 3, elementIds: ["img-1"] },
    });
    const original = makeImageElement("img-1");
    const clone = makeImageElement("img-2");

    const duplicates = findUnregisteredLinkedDuplicates([
      frame as any,
      original as any,
      clone as any,
    ]);

    expect(duplicates.map((el) => el.id)).toEqual(["img-2"]);
  });

  it("copies the file on disk with a sequence suffix and re-points the clone", async () => {
    const { duplicateLinkedFiles } = await import("../linkedAssets/duplicate");

    const files: Record<string, FakeFile> = {
      "a.png": new FakeFile("a.png", "abc"),
    };
    folderEntries.set("folder-1", {
      handle: makeFakeDir(files),
      rootName: "root",
      lastUsedAt: 1,
    });

    const frame = makeSyncFrame({
      "a.png": { size: 3, elementIds: ["img-1"] },
    });
    const original = makeImageElement("img-1");
    const clone = makeImageElement("img-2");
    const api = makeExcalidrawAPI([frame, original, clone]);

    await duplicateLinkedFiles(api, [clone as any]);

    expect(files["a-1.png"]).toBeDefined();
    expect(files["a-1.png"].content).toBe("abc");

    const updated = api
      .getSceneElementsIncludingDeleted()
      .find((el) => el.id === "img-2")!;
    const meta = updated.customData!.linkedFile as LinkedFileMeta;
    expect(meta.relPath).toBe("a-1.png");
    expect(meta.displayName).toBe("a-1.png");
    expect(meta.fileSize).toBe(3);

    const updatedFrame = api
      .getSceneElementsIncludingDeleted()
      .find((el) => el.id === "frame-1")!;
    const manifest = (updatedFrame.customData!.syncFolder as SyncFolderMeta)
      .manifest;
    expect(manifest["a.png"].elementIds).toEqual(["img-1"]);
    expect(manifest["a-1.png"].elementIds).toEqual(["img-2"]);
  });

  it("bumps the sequence when the first suffix is taken", async () => {
    const { duplicateLinkedFiles } = await import("../linkedAssets/duplicate");

    const files: Record<string, FakeFile> = {
      "a.png": new FakeFile("a.png", "abc"),
      "a-1.png": new FakeFile("a-1.png", "abcd"),
    };
    folderEntries.set("folder-1", {
      handle: makeFakeDir(files),
      rootName: "root",
      lastUsedAt: 1,
    });

    const frame = makeSyncFrame({
      "a.png": { size: 3, elementIds: ["img-1"] },
      "a-1.png": { size: 4, elementIds: ["img-2"] },
    });
    const clone = makeImageElement("img-3");
    const api = makeExcalidrawAPI([frame, makeImageElement("img-1"), clone]);

    await duplicateLinkedFiles(api, [clone as any]);

    expect(files["a-2.png"]).toBeDefined();
    const updated = api
      .getSceneElementsIncludingDeleted()
      .find((el) => el.id === "img-3")!;
    expect((updated.customData!.linkedFile as LinkedFileMeta).relPath).toBe(
      "a-2.png",
    );
  });
});

// ---------------------------------------------------------------------------
// import cell sizing
// ---------------------------------------------------------------------------

describe("computeImportCellSize", () => {
  it("sizes cells as a share of the frame when it has no images yet", async () => {
    const { computeImportCellSize } = await import("../linkedAssets/importer");

    expect(computeImportCellSize({ width: 800, height: 600 }, [])).toEqual({
      cellWidth: 150,
      cellHeight: 150,
    });
  });

  it("matches the average size of existing images", async () => {
    const { computeImportCellSize } = await import("../linkedAssets/importer");

    const cell = computeImportCellSize({ width: 2000, height: 2000 }, [
      { width: 200, height: 100 },
      { width: 400, height: 300 },
    ]);
    expect(cell).toEqual({ cellWidth: 320, cellHeight: 220 });
  });
});

describe("grid layout helpers", () => {
  it("gridColumns always fits at least one column", async () => {
    const { gridColumns } = await import("../linkedAssets/importer");

    expect(
      gridColumns({ width: 100 }, { cellWidth: 300, cellHeight: 300 }),
    ).toBe(1);
    expect(
      gridColumns({ width: 1000 }, { cellWidth: 100, cellHeight: 100 }),
    ).toBeGreaterThan(1);
  });

  it("gridPositionFor wraps to the next row after `columns` cells", async () => {
    const { gridPositionFor } = await import("../linkedAssets/importer");

    const frame = { x: 0, y: 0 };
    const cellSize = { cellWidth: 150, cellHeight: 150 };
    const first = gridPositionFor(frame, cellSize, 2, 0, 100, 100);
    const second = gridPositionFor(frame, cellSize, 2, 1, 100, 100);
    const third = gridPositionFor(frame, cellSize, 2, 2, 100, 100);
    expect(second.x).toBeGreaterThan(first.x);
    expect(third.x).toBe(first.x);
    expect(third.y).toBeGreaterThan(first.y);
  });

  it("growFrameToFit grows downward and never shrinks", async () => {
    const { growFrameToFit } = await import("../linkedAssets/importer");

    expect(growFrameToFit({ y: 0, height: 600 }, 1000)).toBeGreaterThan(600);
    expect(growFrameToFit({ y: 0, height: 600 }, 100)).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// deletion
// ---------------------------------------------------------------------------

describe("deleteLinkedFile", { timeout: 20000 }, () => {
  beforeEach(() => {
    folderEntries.clear();
  });

  it("deletes the file and its manifest entry when the last reference is deleted", async () => {
    const { deleteLinkedFile } = await import("../linkedAssets/deletion");

    const files: Record<string, FakeFile> = {
      "a.png": new FakeFile("a.png", "abc"),
    };
    folderEntries.set("folder-1", {
      handle: makeFakeDir(files),
      rootName: "root",
      lastUsedAt: 1,
    });

    const frame = makeSyncFrame({
      "a.png": { size: 3, elementIds: ["img-1"] },
    });
    // img-1 already deleted on the board
    const deleted = { ...makeImageElement("img-1"), isDeleted: true };
    const api = makeExcalidrawAPI([frame, deleted]);

    await deleteLinkedFile(api, "folder-1", "a.png", "img-1");

    expect(files["a.png"]).toBeUndefined();

    const updatedFrame = api
      .getSceneElementsIncludingDeleted()
      .find((el) => el.id === "frame-1")!;
    const manifest = (updatedFrame.customData!.syncFolder as SyncFolderMeta)
      .manifest;
    expect(manifest["a.png"]).toBeUndefined();
  });

  it("keeps the file when another live element references it", async () => {
    const { deleteLinkedFile } = await import("../linkedAssets/deletion");

    const files: Record<string, FakeFile> = {
      "a.png": new FakeFile("a.png", "abc"),
    };
    folderEntries.set("folder-1", {
      handle: makeFakeDir(files),
      rootName: "root",
      lastUsedAt: 1,
    });

    const frame = makeSyncFrame({
      "a.png": { size: 3, elementIds: ["img-1", "img-2"] },
    });
    const deleted = { ...makeImageElement("img-1"), isDeleted: true };
    const alive = makeImageElement("img-2");
    const api = makeExcalidrawAPI([frame, deleted, alive]);

    await deleteLinkedFile(api, "folder-1", "a.png", "img-1");

    expect(files["a.png"]).toBeDefined();

    const updatedFrame = api
      .getSceneElementsIncludingDeleted()
      .find((el) => el.id === "frame-1")!;
    const manifest = (updatedFrame.customData!.syncFolder as SyncFolderMeta)
      .manifest;
    expect(manifest["a.png"].elementIds).toEqual(["img-2"]);
  });

  it("tolerates the file being already gone from disk", async () => {
    const { deleteLinkedFile } = await import("../linkedAssets/deletion");

    folderEntries.set("folder-1", {
      handle: makeFakeDir({}),
      rootName: "root",
      lastUsedAt: 1,
    });

    const frame = makeSyncFrame({
      "a.png": { size: 3, elementIds: ["img-1"] },
    });
    const deleted = { ...makeImageElement("img-1"), isDeleted: true };
    const api = makeExcalidrawAPI([frame, deleted]);

    await deleteLinkedFile(api, "folder-1", "a.png", "img-1");

    const updatedFrame = api
      .getSceneElementsIncludingDeleted()
      .find((el) => el.id === "frame-1")!;
    const manifest = (updatedFrame.customData!.syncFolder as SyncFolderMeta)
      .manifest;
    expect(manifest["a.png"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// frame actions (context menu)
// ---------------------------------------------------------------------------

describe("frameActions", { timeout: 20000 }, () => {
  beforeEach(() => {
    folderEntries.clear();
  });

  const makeFrameWithSize = (manifest: SyncFolderMeta["manifest"]) => ({
    ...makeSyncFrame(manifest),
    x: 0,
    y: 0,
    width: 800,
    height: 600,
  });

  it("showHiddenImages un-deletes hidden linked images", async () => {
    const { showHiddenImages } = await import("../linkedAssets/frameActions");

    const frame = makeFrameWithSize({
      "a.png": { size: 3, elementIds: ["img-1"] },
    });
    const hidden = { ...makeImageElement("img-1"), isDeleted: true };
    const api = makeExcalidrawAPI([frame, hidden]);

    showHiddenImages(api, "frame-1");

    const updated = api
      .getSceneElementsIncludingDeleted()
      .find((el) => el.id === "img-1")!;
    expect(updated.isDeleted).toBe(false);
  });

  it("deleteHiddenImages deletes files of hidden images only", async () => {
    const { deleteHiddenImages } = await import("../linkedAssets/frameActions");

    const files: Record<string, FakeFile> = {
      "a.png": new FakeFile("a.png", "abc"),
      "b.png": new FakeFile("b.png", "def"),
    };
    folderEntries.set("folder-1", {
      handle: makeFakeDir(files),
      rootName: "root",
      lastUsedAt: 1,
    });

    const frame = makeFrameWithSize({
      "a.png": { size: 3, elementIds: ["img-1"] },
      "b.png": { size: 3, elementIds: ["img-2"] },
    });
    const hidden = {
      ...makeImageElement("img-1", { relPath: "a.png", displayName: "a.png" }),
      isDeleted: true,
    };
    const visible = makeImageElement("img-2", {
      relPath: "b.png",
      displayName: "b.png",
    });
    const api = makeExcalidrawAPI([frame, hidden, visible]);

    await deleteHiddenImages(api, "frame-1");

    expect(files["a.png"]).toBeUndefined();
    expect(files["b.png"]).toBeDefined();

    const updatedFrame = api
      .getSceneElementsIncludingDeleted()
      .find((el) => el.id === "frame-1")!;
    const manifest = (updatedFrame.customData!.syncFolder as SyncFolderMeta)
      .manifest;
    expect(manifest["a.png"]).toBeUndefined();
    expect(manifest["b.png"]).toBeDefined();
  });

  it("resetSyncFrameLayout unhides and re-lays out images in a grid", async () => {
    const { resetSyncFrameLayout } = await import(
      "../linkedAssets/frameActions"
    );

    const frame = makeFrameWithSize({
      "a.png": { size: 3, elementIds: ["img-1"] },
      "b.png": { size: 3, elementIds: ["img-2"] },
    });
    const hidden = {
      ...makeImageElement("img-1"),
      isDeleted: true,
      x: 500,
      y: 400,
      width: 100,
      height: 100,
    };
    const visible = {
      ...makeImageElement("img-2", { relPath: "b.png", displayName: "b.png" }),
      x: 20,
      y: 10,
      width: 100,
      height: 100,
    };
    const api = makeExcalidrawAPI([frame, hidden, visible]);

    resetSyncFrameLayout(api, "frame-1");

    const elements = api.getSceneElementsIncludingDeleted();
    const img1 = elements.find((el) => el.id === "img-1")!;
    const img2 = elements.find((el) => el.id === "img-2")!;
    // hidden image is back and both sit inside the frame in manifest order
    // (a.png → first cell, b.png → second cell)
    expect(img1.isDeleted).toBe(false);
    expect(img1.x).toBeLessThan(img2.x);
    expect(img1.y).toBeGreaterThanOrEqual(frame.y);
    expect(img2.x).toBeLessThan(frame.x + frame.width);
  });

  it("resetSyncFrameLayout pulls back images dragged out of the frame", async () => {
    const { resetSyncFrameLayout } = await import(
      "../linkedAssets/frameActions"
    );

    const frame = makeFrameWithSize({
      "a.png": { size: 3, elementIds: ["img-1"] },
    });
    const outside = {
      ...makeImageElement("img-1"),
      frameId: null,
      x: 5000,
      y: 5000,
      width: 100,
      height: 100,
    };
    const api = makeExcalidrawAPI([frame, outside]);

    resetSyncFrameLayout(api, "frame-1");

    const img = api
      .getSceneElementsIncludingDeleted()
      .find((el) => el.id === "img-1")!;
    expect(img.frameId).toBe("frame-1");
    expect(img.x).toBeGreaterThanOrEqual(frame.x);
    expect(img.x).toBeLessThan(frame.x + frame.width);
    expect(img.y).toBeGreaterThanOrEqual(frame.y);
  });

  it("resetSyncFrameLayout grows the frame when the grid overflows it", async () => {
    const { resetSyncFrameLayout } = await import(
      "../linkedAssets/frameActions"
    );

    const manifest: SyncFolderMeta["manifest"] = {};
    const images = [];
    for (let i = 1; i <= 6; i++) {
      manifest[`img${i}.png`] = { size: 3, elementIds: [`img-${i}`] };
      images.push({
        ...makeImageElement(`img-${i}`, {
          relPath: `img${i}.png`,
          displayName: `img${i}.png`,
        }),
        width: 100,
        height: 100,
      });
    }
    // frame too small for 6 images of 100x100
    const frame = { ...makeFrameWithSize(manifest), width: 300, height: 200 };
    const api = makeExcalidrawAPI([frame, ...images]);

    resetSyncFrameLayout(api, "frame-1");

    const updatedFrame = api
      .getSceneElementsIncludingDeleted()
      .find((el) => el.id === "frame-1")!;
    expect(updatedFrame.height).toBeGreaterThan(200);
    // every image fits inside the grown frame
    for (const el of api.getSceneElementsIncludingDeleted()) {
      if (el.type !== "image") {
        continue;
      }
      expect(el.y + el.height).toBeLessThanOrEqual(
        updatedFrame.y + updatedFrame.height,
      );
    }
  });

  it("resetSyncFrameLayout restores cell-fitted image sizes", async () => {
    const { resetSyncFrameLayout } = await import(
      "../linkedAssets/frameActions"
    );

    const frame = makeFrameWithSize({
      "a.png": { size: 3, elementIds: ["img-1"] },
    });
    // user enlarged the image: 400x200 (cell is 150, inner 130 for 800x600)
    const enlarged = {
      ...makeImageElement("img-1"),
      width: 400,
      height: 200,
    };
    const api = makeExcalidrawAPI([frame, enlarged]);

    resetSyncFrameLayout(api, "frame-1");

    const img = api
      .getSceneElementsIncludingDeleted()
      .find((el) => el.id === "img-1")!;
    expect(img.width).toBe(130);
    expect(img.height).toBe(65);
  });

  it("deleteFolderImages removes the folder's images from the board only", async () => {
    const { deleteFolderImages } = await import("../linkedAssets/frameActions");

    const files: Record<string, FakeFile> = {
      "a.png": new FakeFile("a.png", "abc"),
      "b.png": new FakeFile("b.png", "def"),
    };
    folderEntries.set("folder-1", {
      handle: makeFakeDir(files),
      rootName: "root",
      lastUsedAt: 1,
    });

    const frame = makeFrameWithSize({
      "a.png": { size: 3, elementIds: ["img-1"] },
      "b.png": { size: 3, elementIds: ["img-2"] },
    });
    const img1 = makeImageElement("img-1");
    const img2 = makeImageElement("img-2", {
      relPath: "b.png",
      displayName: "b.png",
    });
    // image of another folder is untouched
    const other = makeImageElement("img-3", { folderId: "folder-2" });
    const api = makeExcalidrawAPI([frame, img1, img2, other]);

    deleteFolderImages(api, "folder-1");

    const elements = api.getSceneElementsIncludingDeleted();
    expect(elements.find((el) => el.id === "img-1")!.isDeleted).toBe(true);
    expect(elements.find((el) => el.id === "img-2")!.isDeleted).toBe(true);
    expect(elements.find((el) => el.id === "img-3")!.isDeleted).toBe(false);
    // files on disk are never touched
    expect(files["a.png"]).toBeDefined();
    expect(files["b.png"]).toBeDefined();
  });

  it("unlinkFolderLinks strips link metadata without touching files", async () => {
    const { unlinkFolderLinks } = await import("../linkedAssets/frameActions");

    const files: Record<string, FakeFile> = {
      "a.png": new FakeFile("a.png", "abc"),
    };
    folderEntries.set("folder-1", {
      handle: makeFakeDir(files),
      rootName: "root",
      lastUsedAt: 1,
    });

    const frame = makeFrameWithSize({
      "a.png": { size: 3, elementIds: ["img-1"] },
    });
    const image = makeImageElement("img-1");
    const api = makeExcalidrawAPI([frame, image]);

    unlinkFolderLinks(api, "folder-1");

    const updated = api
      .getSceneElementsIncludingDeleted()
      .find((el) => el.id === "img-1")!;
    expect(updated.customData?.linkedFile).toBeUndefined();
    expect(files["a.png"]).toBeDefined();
  });
});
