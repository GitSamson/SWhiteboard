/**
 * Verifier for the "linked file assets" feature.
 *
 * Runs after scene load and on window focus. For every sync frame it scans
 * the bound folder's root directory (one level, no recursion) and reconciles
 * the frame manifest against reality:
 *
 * - same path, same size      → file intact; recover elements from "missing"
 * - same path, different size → file modified; regenerate thumbnail
 * - path gone, exactly one new disk file with the same size → treat as a
 *   rename; update relPath/displayName
 * - path gone, no candidate   → mark elements "missing" (never auto-delete)
 * - disk files unknown to the manifest → auto-import into the frame
 *
 * Verification never prompts for permission: folders without a granted
 * readwrite permission are skipped silently.
 */

import {
  CaptureUpdateAction,
  isFrameElement,
  isImageElement,
  newElementWith,
} from "@excalidraw/element";

import type { ExcalidrawFrameElement } from "@excalidraw/element/types";

import type {
  BinaryFileData,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { blobToDataURL } from "./convert";
import { importNewFilesIntoFrame } from "./importer";
import { invalidateLinkedOriginal } from "./originals";
import { getFolderEntry, queryFolderPermission } from "./folderRegistry";
import { generateThumbnail } from "./thumbnail";
import { isLinkedAssetsAvailable } from "./state";

import type { LinkedFileMeta, SyncFolderMeta } from "./types";

const IMAGE_FILE_PATTERN = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|jfif)$/i;

interface DiskFileInfo {
  name: string;
  size: number;
}

/** lists files in the root of `dir` (one level) with their sizes */
const scanDirectory = async (
  dir: FileSystemDirectoryHandle,
): Promise<DiskFileInfo[]> => {
  const result: DiskFileInfo[] = [];
  // FileSystemDirectoryHandle is async-iterable; the project's TS lib may
  // lack the entries() typing, hence the cast
  const iterable = dir as unknown as {
    entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
  };
  for await (const [name, handle] of iterable.entries()) {
    if (handle.kind !== "file") {
      continue;
    }
    const file = await (handle as FileSystemFileHandle).getFile();
    result.push({ name, size: file.size });
  }
  return result;
};

const getLinkedMeta = (element: {
  customData?: Record<string, any>;
}): LinkedFileMeta | null =>
  (element.customData?.linkedFile as LinkedFileMeta | undefined) ?? null;

/** whether `name` is known to the manifest, accounting for pending renames */
const manifestKnows = (
  manifest: SyncFolderMeta["manifest"],
  renames: Map<string, string>,
  name: string,
): boolean => {
  if (manifest[name]) {
    return true;
  }
  for (const newName of renames.values()) {
    if (newName === name) {
      return true;
    }
  }
  return false;
};

const verifyFrame = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
  frame: ExcalidrawFrameElement,
  syncFolder: SyncFolderMeta,
): Promise<void> => {
  const entry = await getFolderEntry(syncFolder.folderId);
  if (!entry) {
    return;
  }
  if ((await queryFolderPermission(entry.handle)) !== "granted") {
    return;
  }

  const diskFiles = await scanDirectory(entry.handle);
  const diskByName = new Map(diskFiles.map((f) => [f.name, f.size]));

  const linkedElements = excalidrawAPI
    .getSceneElementsIncludingDeleted()
    .filter((el) => getLinkedMeta(el)?.folderId === syncFolder.folderId);

  const manifest = syncFolder.manifest;

  // disk names consumed by exact matches or rename matching
  const consumedDiskNames = new Set<string>();
  // old relPath → new name (rename detected)
  const renames = new Map<string, string>();
  const missingPaths = new Set<string>();
  const modifiedPaths = new Set<string>();

  for (const [relPath, manifestEntry] of Object.entries(manifest)) {
    const diskSize = diskByName.get(relPath);
    if (diskSize !== undefined) {
      consumedDiskNames.add(relPath);
      if (diskSize !== manifestEntry.size) {
        modifiedPaths.add(relPath);
      }
      continue;
    }
    // path gone: exactly one unmatched disk file with the same size = rename
    const candidates = diskFiles.filter(
      (f) =>
        !manifest[f.name] &&
        !consumedDiskNames.has(f.name) &&
        f.size === manifestEntry.size,
    );
    if (candidates.length === 1) {
      renames.set(relPath, candidates[0].name);
      consumedDiskNames.add(candidates[0].name);
    } else {
      missingPaths.add(relPath);
    }
  }

  // regenerate thumbnails for modified files
  const newThumbnails: Record<string, { dataURL: DataURL; size: number }> = {};
  for (const relPath of modifiedPaths) {
    try {
      const fileHandle = await entry.handle.getFileHandle(relPath);
      const file = await fileHandle.getFile();
      const thumbnail = await generateThumbnail(await blobToDataURL(file));
      newThumbnails[relPath] = { dataURL: thumbnail.dataURL, size: file.size };
    } catch (error) {
      console.warn(`failed to refresh thumbnail for ${relPath}`, error);
    }
  }

  const needsRecovery = linkedElements.some(
    (el) => getLinkedMeta(el)?.status === "missing",
  );
  const hasChanges =
    renames.size > 0 ||
    missingPaths.size > 0 ||
    Object.keys(newThumbnails).length > 0 ||
    needsRecovery;

  if (hasChanges) {
    const updatedManifest = { ...manifest };
    // renames move entries; modified files get new sizes; missing entries
    // stay so a returning file recovers
    for (const [oldPath, newName] of renames) {
      const manifestEntry = updatedManifest[oldPath];
      if (manifestEntry) {
        delete updatedManifest[oldPath];
        updatedManifest[newName] = manifestEntry;
      }
    }
    for (const [relPath, thumb] of Object.entries(newThumbnails)) {
      const manifestEntry = updatedManifest[relPath];
      if (manifestEntry) {
        updatedManifest[relPath] = { ...manifestEntry, size: thumb.size };
      }
    }

    const updatedElements = excalidrawAPI
      .getSceneElementsIncludingDeleted()
      .map((element) => {
        if (element.id === frame.id) {
          return newElementWith(element, {
            customData: {
              ...element.customData,
              syncFolder: { ...syncFolder, manifest: updatedManifest },
            },
          });
        }

        const meta = getLinkedMeta(element);
        if (!meta || meta.folderId !== syncFolder.folderId) {
          return element;
        }

        const renamedTo = renames.get(meta.relPath);
        if (renamedTo) {
          const nextMeta: LinkedFileMeta = {
            ...meta,
            relPath: renamedTo,
            displayName: renamedTo.split("/").pop() ?? renamedTo,
            status: "ok",
          };
          return newElementWith(element, {
            customData: { ...element.customData, linkedFile: nextMeta },
          });
        }
        if (missingPaths.has(meta.relPath)) {
          if (meta.status === "missing") {
            return element;
          }
          return newElementWith(element, {
            customData: {
              ...element.customData,
              linkedFile: { ...meta, status: "missing" as const },
            },
          });
        }
        if (newThumbnails[meta.relPath]) {
          if (isImageElement(element) && element.fileId) {
            invalidateLinkedOriginal(element.fileId);
          }
          const nextMeta: LinkedFileMeta = {
            ...meta,
            fileSize: newThumbnails[meta.relPath].size,
            status: "ok",
          };
          return newElementWith(element, {
            customData: { ...element.customData, linkedFile: nextMeta },
          });
        }
        if (meta.status === "missing" && diskByName.has(meta.relPath)) {
          // file is back on disk
          return newElementWith(element, {
            customData: {
              ...element.customData,
              linkedFile: { ...meta, status: "ok" as const },
            },
          });
        }
        return element;
      });

    // swap thumbnails of modified files
    const filesToReplace = Object.entries(newThumbnails)
      .map(([relPath, thumb]) => {
        const element = linkedElements.find(
          (el) => getLinkedMeta(el)?.relPath === relPath,
        );
        if (!element || !isImageElement(element) || !element.fileId) {
          return null;
        }
        const existing = excalidrawAPI.getFiles()[element.fileId];
        if (!existing) {
          return null;
        }
        return {
          ...existing,
          mimeType: "image/webp" as BinaryFileData["mimeType"],
          dataURL: thumb.dataURL,
          version: (existing.version ?? 1) + 1,
          lastRetrieved: Date.now(),
        };
      })
      .filter((f): f is NonNullable<typeof f> => !!f);
    if (filesToReplace.length) {
      excalidrawAPI.addFiles(filesToReplace, { replace: true });
    }

    excalidrawAPI.updateScene({
      elements: updatedElements,
      // background reconciliation must not pollute undo history
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }

  // new files on disk unknown to the manifest → import into the frame
  const newNames = diskFiles.filter(
    (f) =>
      IMAGE_FILE_PATTERN.test(f.name) &&
      !manifestKnows(manifest, renames, f.name) &&
      !consumedDiskNames.has(f.name),
  );
  if (newNames.length) {
    await importNewFilesIntoFrame(excalidrawAPI, frame.id, newNames);
  }
};

/**
 * Verifies every sync frame on the scene against its bound folder.
 * Skips silently when the feature is off, the tab is hidden, or folder
 * permissions aren't granted.
 */
export const verifyLinkedAssets = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
): Promise<void> => {
  if (!isLinkedAssetsAvailable()) {
    return;
  }
  if (typeof document !== "undefined" && document.hidden) {
    return;
  }

  const syncFrames = excalidrawAPI
    .getSceneElementsIncludingDeleted()
    .filter(
      (el) =>
        isFrameElement(el) && !el.isDeleted && !!el.customData?.syncFolder,
    ) as unknown as ExcalidrawFrameElement[];

  for (const frame of syncFrames) {
    try {
      await verifyFrame(
        excalidrawAPI,
        frame,
        frame.customData!.syncFolder as SyncFolderMeta,
      );
    } catch (error) {
      console.error("linked assets verification failed", error);
    }
  }
};
