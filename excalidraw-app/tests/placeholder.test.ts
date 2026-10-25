/**
 * Unit tests for file-icon placeholders (app layer): unknown-format files in
 * a sync folder are imported as image elements carrying a generated icon,
 * with `customData.linkedFile.placeholder` set so rename/duplicate/delete
 * keep working on the real file while the original is never decoded.
 *
 * File System Access handles and the excalidraw API are faked in-memory;
 * canvas-based generation (thumbnails + the icon itself) is mocked out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { getFileExtensionLabel } from "../linkedAssets/placeholder";

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
      originalWidth: 800,
      originalHeight: 800,
    }),
  };
});

vi.mock("../linkedAssets/convert", () => ({
  blobToDataURL: async () => "data:image/png;base64,AAAA" as const,
}));

// keep the pure helpers (getFileExtensionLabel) real; only the canvas-bound
// generator is replaced (jsdom has no canvas 2d context)
vi.mock("../linkedAssets/placeholder", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../linkedAssets/placeholder")
  >();
  return {
    ...original,
    generateFilePlaceholder: () => ({
      dataURL: "data:image/webp;base64,BBBB" as const,
      width: 240,
      height: 300,
    }),
  };
});

// ---------------------------------------------------------------------------
// fakes
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

const makeFakeDir = (files: Record<string, FakeFile>) =>
  ({
    kind: "directory" as const,
    name: "root",
    getFileHandle: async (name: string) => {
      if (!files[name]) {
        throw new DOMException("not found", "NotFoundError");
      }
      return { kind: "file", getFile: async () => files[name] };
    },
  } as unknown as FileSystemDirectoryHandle);

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
    addFiles: ReturnType<typeof vi.fn>;
    updateScene: ReturnType<typeof vi.fn>;
  };
};

const makeSyncFrame = (manifest: SyncFolderMeta["manifest"]) => ({
  id: "frame-1",
  type: "frame",
  isDeleted: false,
  x: 0,
  y: 0,
  width: 800,
  height: 600,
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

describe("getFileExtensionLabel", () => {
  it("uppercases the extension", () => {
    expect(getFileExtensionLabel("notes.txt")).toBe("TXT");
    expect(getFileExtensionLabel("photo.Psd")).toBe("PSD");
  });

  it("uses the last extension of multi-dot names", () => {
    expect(getFileExtensionLabel("archive.tar.gz")).toBe("GZ");
  });

  it("falls back to FILE without a usable extension", () => {
    expect(getFileExtensionLabel("Makefile")).toBe("FILE");
    expect(getFileExtensionLabel(".hidden")).toBe("FILE");
    expect(getFileExtensionLabel("trailingdot.")).toBe("FILE");
    expect(getFileExtensionLabel("toolong.abcdefghij")).toBe("FILE");
  });
});

// ---------------------------------------------------------------------------
// importer
// ---------------------------------------------------------------------------

describe("importNewFilesIntoFrame placeholders", { timeout: 20000 }, () => {
  beforeEach(() => {
    folderEntries.clear();
  });

  it("imports an unknown-format file as a file-icon placeholder", async () => {
    const { importNewFilesIntoFrame } = await import(
      "../linkedAssets/importer"
    );

    folderEntries.set("folder-1", {
      handle: makeFakeDir({
        "notes.txt": new FakeFile("notes.txt", "hello", "text/plain"),
      }),
      rootName: "root",
      lastUsedAt: 1,
    });

    const api = makeExcalidrawAPI([makeSyncFrame({})]);
    await importNewFilesIntoFrame(api, "frame-1", [
      { name: "notes.txt", size: 5 },
    ]);

    // the icon goes into BinaryFiles as webp
    expect(api.addFiles).toHaveBeenCalledWith([
      expect.objectContaining({
        mimeType: "image/webp",
        dataURL: "data:image/webp;base64,BBBB",
      }),
    ]);

    const elements = api.getSceneElementsIncludingDeleted();
    const imported = elements.find(
      (el) => el.type === "image" && !el.isDeleted,
    )!;
    expect(imported).toBeDefined();
    const meta = imported.customData!.linkedFile as LinkedFileMeta;
    expect(meta.placeholder).toBe(true);
    expect(meta.relPath).toBe("notes.txt");
    expect(meta.displayName).toBe("notes.txt");
    expect(meta.mimeType).toBe("text/plain");
    expect(meta.fileSize).toBe(5);
    // icon dimensions recorded as the "original" size
    expect(meta.width).toBe(240);
    expect(meta.height).toBe(300);
    // laid out inside the frame
    expect(imported.x).toBeGreaterThanOrEqual(0);
    expect(imported.y).toBeGreaterThanOrEqual(0);

    const frame = elements.find((el) => el.id === "frame-1")!;
    const manifest = (frame.customData!.syncFolder as SyncFolderMeta).manifest;
    expect(manifest["notes.txt"].elementIds).toEqual([imported.id]);
  });

  it("imports images and unknown formats side by side", async () => {
    const { importNewFilesIntoFrame } = await import(
      "../linkedAssets/importer"
    );

    folderEntries.set("folder-1", {
      handle: makeFakeDir({
        "pic.png": new FakeFile("pic.png", "png-bytes"),
        "doc.pdf": new FakeFile("doc.pdf", "pdf-bytes", "application/pdf"),
      }),
      rootName: "root",
      lastUsedAt: 1,
    });

    const api = makeExcalidrawAPI([makeSyncFrame({})]);
    await importNewFilesIntoFrame(api, "frame-1", [
      { name: "pic.png", size: 9 },
      { name: "doc.pdf", size: 9 },
    ]);

    const images = api
      .getSceneElementsIncludingDeleted()
      .filter((el) => el.type === "image" && !el.isDeleted);
    expect(images).toHaveLength(2);

    const byRelPath = new Map(
      images.map((el) => [
        (el.customData!.linkedFile as LinkedFileMeta).relPath,
        el.customData!.linkedFile as LinkedFileMeta,
      ]),
    );
    expect(byRelPath.get("pic.png")!.placeholder).toBeUndefined();
    expect(byRelPath.get("pic.png")!.width).toBe(800);
    expect(byRelPath.get("doc.pdf")!.placeholder).toBe(true);
  });

  it("treats a renamed non-image with an image extension as a placeholder", async () => {
    const { importNewFilesIntoFrame } = await import(
      "../linkedAssets/importer"
    );

    folderEntries.set("folder-1", {
      handle: makeFakeDir({
        "evil.png": new FakeFile("evil.png", "not-an-image", "application/pdf"),
      }),
      rootName: "root",
      lastUsedAt: 1,
    });

    const api = makeExcalidrawAPI([makeSyncFrame({})]);
    await importNewFilesIntoFrame(api, "frame-1", [
      { name: "evil.png", size: 12 },
    ]);

    const imported = api
      .getSceneElementsIncludingDeleted()
      .find((el) => el.type === "image" && !el.isDeleted)!;
    expect(
      (imported.customData!.linkedFile as LinkedFileMeta).placeholder,
    ).toBe(true);
  });
});
