/**
 * Unit tests for the interactive linked-original resolver (app layer): used
 * by user-gesture flows such as "copy original image data". Unlike the
 * render-path resolver it may PROMPT for folder permission, and it never
 * silently falls back — null means "surface a reconnect hint".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import type { LinkedFileMeta } from "../linkedAssets/types";

const folderEntries = new Map<
  string,
  { handle: any; rootName: string; lastUsedAt: number }
>();
const ensureFolderPermission = vi.fn(async () => true);

vi.mock("../linkedAssets/folderRegistry", () => ({
  getFolderEntry: async (folderId: string) => folderEntries.get(folderId),
  queryFolderPermission: async () => "granted",
  ensureFolderPermission: (...args: any[]) => ensureFolderPermission(...args),
  listFolderEntries: async () => [...folderEntries.entries()],
  registerFolder: vi.fn(),
  touchFolder: vi.fn(),
  unregisterFolder: vi.fn(),
}));

vi.mock("../linkedAssets/convert", () => ({
  blobToDataURL: async () => "data:image/png;base64,ORIGINAL" as const,
}));

const makeFakeDir = (files: Record<string, { content: string }>) =>
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

const makeImageElement = (id: string, linkedFile: Partial<LinkedFileMeta>) => ({
  id,
  type: "image",
  isDeleted: false,
  fileId: `file-${id}`,
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

const makeExcalidrawAPI = (elements: any[]) =>
  ({
    getSceneElements: () => elements.filter((el) => !el.isDeleted),
  } as unknown as ExcalidrawImperativeAPI);

describe("createLinkedImageInteractiveResolver", () => {
  beforeEach(() => {
    folderEntries.clear();
    ensureFolderPermission.mockReset();
    ensureFolderPermission.mockResolvedValue(true);
  });

  it("prompts for permission and returns the original dataURL", async () => {
    const { createLinkedImageInteractiveResolver } = await import(
      "../linkedAssets/originals"
    );
    folderEntries.set("folder-1", {
      handle: makeFakeDir({ "a.png": { content: "abc" } }),
      rootName: "root",
      lastUsedAt: 1,
    });
    const api = makeExcalidrawAPI([makeImageElement("img-1", {})]);
    const resolve = createLinkedImageInteractiveResolver(api);

    const result = await resolve("file-img-1" as any, {} as any);

    expect(ensureFolderPermission).toHaveBeenCalled();
    expect(result).toBe("data:image/png;base64,ORIGINAL");
  });

  it("returns null without prompting for placeholders", async () => {
    const { createLinkedImageInteractiveResolver } = await import(
      "../linkedAssets/originals"
    );
    folderEntries.set("folder-1", {
      handle: makeFakeDir({ "a.png": { content: "abc" } }),
      rootName: "root",
      lastUsedAt: 1,
    });
    const api = makeExcalidrawAPI([
      makeImageElement("img-1", { placeholder: true }),
    ]);
    const resolve = createLinkedImageInteractiveResolver(api);

    const result = await resolve("file-img-1" as any, {} as any);

    expect(result).toBeNull();
    expect(ensureFolderPermission).not.toHaveBeenCalled();
  });

  it("returns null when the folder handle is gone", async () => {
    const { createLinkedImageInteractiveResolver } = await import(
      "../linkedAssets/originals"
    );
    // distinct fileId — the resolver caches originals in-memory per fileId
    const api = makeExcalidrawAPI([makeImageElement("img-gone", {})]);
    const resolve = createLinkedImageInteractiveResolver(api);

    const result = await resolve("file-img-gone" as any, {} as any);

    expect(result).toBeNull();
  });

  it("returns null when the user denies the permission prompt", async () => {
    const { createLinkedImageInteractiveResolver } = await import(
      "../linkedAssets/originals"
    );
    ensureFolderPermission.mockResolvedValue(false);
    folderEntries.set("folder-1", {
      handle: makeFakeDir({ "a.png": { content: "abc" } }),
      rootName: "root",
      lastUsedAt: 1,
    });
    const api = makeExcalidrawAPI([makeImageElement("img-2", {})]);
    const resolve = createLinkedImageInteractiveResolver(api);

    const result = await resolve("file-img-2" as any, {} as any);

    expect(result).toBeNull();
  });

  it("returns null when the file id is not a linked image", async () => {
    const { createLinkedImageInteractiveResolver } = await import(
      "../linkedAssets/originals"
    );
    const api = makeExcalidrawAPI([]);
    const resolve = createLinkedImageInteractiveResolver(api);

    const result = await resolve("nope" as any, {} as any);

    expect(result).toBeNull();
  });
});
