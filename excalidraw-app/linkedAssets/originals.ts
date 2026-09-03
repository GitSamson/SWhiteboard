/**
 * Original-resolution loading for linked images.
 *
 * Linked image elements keep only a webp thumbnail in the scene BinaryFiles;
 * the original bytes live in the bound folder. This module reads originals
 * back from disk for hi-res canvas rendering (via the resolver injected into
 * @excalidraw/element's image cache) and for PNG/SVG export (via the bridge).
 *
 * Reads are cached in memory per fileId; nothing here ever mutates the
 * scene's files map.
 */

import { isImageElement } from "@excalidraw/element";

import type { FileId } from "@excalidraw/element/types";

import type {
  BinaryFileData,
  BinaryFiles,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { blobToDataURL } from "./convert";
import { readFileByRelPath } from "./fsAccess";
import { getFolderEntry, queryFolderPermission } from "./folderRegistry";

import type { LinkedFileMeta } from "./types";

const originalCache = new Map<string, DataURL>();

export const clearLinkedOriginalCache = (): void => {
  originalCache.clear();
};

/**
 * Invalidates the cached original, e.g. when the verifier detected the file
 * changed on disk. The next render re-reads it.
 */
export const invalidateLinkedOriginal = (fileId: string): void => {
  originalCache.delete(fileId);
};

const findLinkedMetaByFileId = (
  excalidrawAPI: ExcalidrawImperativeAPI,
  fileId: FileId,
): LinkedFileMeta | null => {
  for (const element of excalidrawAPI.getSceneElements()) {
    if (
      isImageElement(element) &&
      element.fileId === fileId &&
      element.customData?.linkedFile
    ) {
      return element.customData.linkedFile as LinkedFileMeta;
    }
  }
  return null;
};

/** reads the original file from disk; null when unavailable */
const loadOriginalDataURL = async (
  meta: LinkedFileMeta,
): Promise<DataURL | null> => {
  if (meta.status === "missing") {
    return null;
  }
  const entry = await getFolderEntry(meta.folderId);
  if (!entry) {
    return null;
  }
  // never trigger a permission prompt from a render/export path — only read
  // when permission is already granted
  if ((await queryFolderPermission(entry.handle)) !== "granted") {
    return null;
  }
  const file = await readFileByRelPath(entry.handle, meta.relPath);
  return blobToDataURL(file);
};

/**
 * Resolver injected into the element package's image cache: returns the
 * original dataURL for linked images, null to fall back to the embedded
 * thumbnail.
 */
export const createLinkedImageResolver =
  (excalidrawAPI: ExcalidrawImperativeAPI) =>
  async (
    fileId: FileId,
    _fileData: BinaryFileData,
  ): Promise<DataURL | null> => {
    const meta = findLinkedMetaByFileId(excalidrawAPI, fileId);
    if (!meta) {
      return null;
    }
    const cached = originalCache.get(fileId);
    if (cached) {
      return cached;
    }
    const dataURL = await loadOriginalDataURL(meta);
    if (dataURL) {
      originalCache.set(fileId, dataURL);
    }
    return dataURL;
  };

/**
 * Returns a copy of `files` with linked thumbnails replaced by their
 * originals (dataURL + mimeType). Used before PNG/SVG export. Files whose
 * original can't be loaded keep their thumbnail.
 */
export const resolveOriginalsForExport = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
  files: BinaryFiles,
): Promise<BinaryFiles> => {
  const metaByFileId = new Map<string, LinkedFileMeta>();
  for (const element of excalidrawAPI.getSceneElements()) {
    if (
      isImageElement(element) &&
      element.fileId &&
      element.customData?.linkedFile
    ) {
      metaByFileId.set(
        element.fileId,
        element.customData.linkedFile as LinkedFileMeta,
      );
    }
  }
  if (!metaByFileId.size) {
    return files;
  }

  const resolved: BinaryFiles = { ...files };
  await Promise.all(
    [...metaByFileId.entries()].map(async ([fileId, meta]) => {
      const fileData = files[fileId];
      if (!fileData) {
        return;
      }
      try {
        const dataURL =
          originalCache.get(fileId) ?? (await loadOriginalDataURL(meta));
        if (dataURL) {
          originalCache.set(fileId, dataURL);
          resolved[fileId] = {
            ...fileData,
            mimeType: meta.mimeType as BinaryFileData["mimeType"],
            dataURL,
          };
        }
      } catch (error) {
        // keep the thumbnail for this file
        console.warn(`failed to load original for ${meta.relPath}`, error);
      }
    }),
  );
  return resolved;
};
