/**
 * Duplication handling for the "linked file assets" feature.
 *
 * Copy/paste, the duplicate action and alt-drag all clone the element
 * including `customData.linkedFile`, so two elements end up pointing at the
 * same file on disk. The sync engine detects such clones (their element id
 * is not recorded in the frame manifest) and enqueues duplicateLinkedFiles,
 * which copies the file on disk under a sequenced name (`name-1`, `name-2`…)
 * and re-points the clone at the copy.
 */

import {
  CaptureUpdateAction,
  isFrameElement,
  isImageElement,
  newElementWith,
} from "@excalidraw/element";

import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
  ExcalidrawImageElement,
} from "@excalidraw/element/types";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  ensureFolderPermission,
  getFolderEntry,
  touchFolder,
} from "./folderRegistry";
import {
  readFileByRelPath,
  resolveAvailableRelPath,
  writeFileByRelPath,
} from "./fsAccess";

import type { LinkedFileMeta, SyncFolderMeta } from "./types";

/**
 * Linked image elements whose id is not recorded in the bound frame's
 * manifest — i.e. clones of another linked element sharing its relPath.
 */
export const findUnregisteredLinkedDuplicates = (
  elements: readonly ExcalidrawElement[],
): ExcalidrawImageElement[] => {
  const manifestByFolder = new Map<string, SyncFolderMeta["manifest"]>();
  for (const element of elements) {
    if (isFrameElement(element) && !element.isDeleted) {
      const syncFolder = element.customData?.syncFolder as
        | SyncFolderMeta
        | undefined;
      if (syncFolder) {
        manifestByFolder.set(syncFolder.folderId, syncFolder.manifest);
      }
    }
  }
  if (!manifestByFolder.size) {
    return [];
  }

  const duplicates: ExcalidrawImageElement[] = [];
  for (const element of elements) {
    if (!isImageElement(element) || element.isDeleted) {
      continue;
    }
    const meta = element.customData?.linkedFile as LinkedFileMeta | undefined;
    if (!meta) {
      continue;
    }
    const manifest = manifestByFolder.get(meta.folderId);
    if (!manifest) {
      continue;
    }
    if (!manifest[meta.relPath]?.elementIds.includes(element.id)) {
      duplicates.push(element);
    }
  }
  return duplicates;
};

/**
 * Re-points cloned linked images at their own on-disk copy, named after the
 * original with a sequence suffix. Failures of individual elements surface
 * as toasts and don't abort the rest.
 */
export const duplicateLinkedFiles = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
  elements: readonly ExcalidrawImageElement[],
): Promise<void> => {
  for (const element of elements) {
    try {
      // re-resolve from fresh scene state; another queue entry may have
      // handled this element in the meantime
      const freshSceneElements =
        excalidrawAPI.getSceneElementsIncludingDeleted();
      const freshElement = freshSceneElements.find(
        (el) => el.id === element.id,
      );
      if (
        !freshElement ||
        freshElement.isDeleted ||
        !isImageElement(freshElement)
      ) {
        continue;
      }
      const meta = freshElement.customData?.linkedFile as
        | LinkedFileMeta
        | undefined;
      if (!meta) {
        continue;
      }

      const frame = freshSceneElements.find(
        (el) =>
          isFrameElement(el) &&
          !el.isDeleted &&
          (el.customData?.syncFolder as SyncFolderMeta | undefined)
            ?.folderId === meta.folderId,
      ) as ExcalidrawFrameElement | undefined;
      const syncFolder = frame?.customData?.syncFolder as
        | SyncFolderMeta
        | undefined;
      if (!frame || !syncFolder) {
        continue;
      }
      if (syncFolder.manifest[meta.relPath]?.elementIds.includes(element.id)) {
        continue;
      }

      const entry = await getFolderEntry(meta.folderId);
      if (!entry) {
        continue;
      }
      if (!(await ensureFolderPermission(entry.handle))) {
        excalidrawAPI.setToast({
          message: `Folder "${entry.rootName}" needs permission to copy files`,
        });
        continue;
      }

      const file = await readFileByRelPath(entry.handle, meta.relPath);
      const relPath = await resolveAvailableRelPath(
        entry.handle,
        meta.displayName,
        new Set(Object.keys(syncFolder.manifest)),
      );
      await writeFileByRelPath(entry.handle, relPath, file);

      const nextMeta: LinkedFileMeta = {
        ...meta,
        relPath,
        displayName: relPath.split("/").pop() ?? relPath,
        fileSize: file.size,
        status: "ok",
      };

      excalidrawAPI.updateScene({
        elements: excalidrawAPI.getSceneElementsIncludingDeleted().map((el) => {
          if (el.id === freshElement.id) {
            return newElementWith(el, {
              customData: { ...el.customData, linkedFile: nextMeta },
            });
          }
          if (el.id === frame.id) {
            const current = el.customData!.syncFolder as SyncFolderMeta;
            return newElementWith(el, {
              customData: {
                ...el.customData,
                syncFolder: {
                  ...current,
                  manifest: {
                    ...current.manifest,
                    [relPath]: {
                      size: file.size,
                      elementIds: [freshElement.id],
                    },
                  },
                },
              },
            });
          }
          return el;
        }),
        captureUpdate: CaptureUpdateAction.EVENTUALLY,
      });

      await touchFolder(meta.folderId);
    } catch (error: any) {
      if (error?.name === "NotFoundError") {
        // the source file is gone (e.g. the element was restored via undo
        // after its file was deleted) — mark the clone as missing instead
        excalidrawAPI.updateScene({
          elements: excalidrawAPI.getSceneElementsIncludingDeleted().map((el) =>
            el.id === element.id && !el.isDeleted
              ? newElementWith(el, {
                  customData: {
                    ...el.customData,
                    linkedFile: {
                      ...(el.customData!.linkedFile as LinkedFileMeta),
                      status: "missing" as const,
                    },
                  },
                })
              : el,
          ),
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        continue;
      }
      console.error(error);
      excalidrawAPI.setToast({
        message: `Failed to copy linked file: ${error?.message ?? error}`,
      });
    }
  }
};
