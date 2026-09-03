/**
 * Deletion propagation for the "linked file assets" feature.
 *
 * Deleting the on-disk file of a linked image element — invoked explicitly
 * via the sync frame's "delete hidden images" context menu entry. The file
 * is only deleted when no other live element still references it; the frame
 * manifest is updated either way.
 *
 * With `interactive: false` (background paths) it never prompts for
 * permission: without a granted permission the manifest entry is kept as-is
 * and the file stays on disk.
 */

import {
  CaptureUpdateAction,
  isFrameElement,
  newElementWith,
} from "@excalidraw/element";

import type { ExcalidrawFrameElement } from "@excalidraw/element/types";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  ensureFolderPermission,
  getFolderEntry,
  queryFolderPermission,
} from "./folderRegistry";
import { deleteFileByRelPath } from "./fsAccess";

import type { LinkedFileMeta, SyncFolderMeta } from "./types";

export const deleteLinkedFile = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
  folderId: string,
  relPath: string,
  deletedElementId: string,
  opts: { interactive?: boolean } = {},
): Promise<void> => {
  const sceneElements = excalidrawAPI.getSceneElementsIncludingDeleted();

  const stillReferenced = sceneElements.some((element) => {
    if (element.isDeleted || element.id === deletedElementId) {
      return false;
    }
    const meta = element.customData?.linkedFile as LinkedFileMeta | undefined;
    return meta?.folderId === folderId && meta.relPath === relPath;
  });

  const frame = sceneElements.find(
    (el) =>
      isFrameElement(el) &&
      !el.isDeleted &&
      (el.customData?.syncFolder as SyncFolderMeta | undefined)?.folderId ===
        folderId,
  ) as ExcalidrawFrameElement | undefined;

  let fileDeleted = false;
  if (!stillReferenced) {
    const entry = await getFolderEntry(folderId);
    const permitted = entry
      ? opts.interactive
        ? await ensureFolderPermission(entry.handle)
        : (await queryFolderPermission(entry.handle)) === "granted"
      : false;
    if (entry && permitted) {
      try {
        await deleteFileByRelPath(entry.handle, relPath);
        fileDeleted = true;
      } catch (error: any) {
        if (error?.name === "NotFoundError") {
          // already gone (e.g. deleted externally)
          fileDeleted = true;
        } else {
          throw error;
        }
      }
    }
  }

  if (!frame) {
    return;
  }
  const syncFolder = frame.customData!.syncFolder as SyncFolderMeta;
  const manifestEntry = syncFolder.manifest[relPath];
  if (!manifestEntry) {
    return;
  }

  const elementIds = manifestEntry.elementIds.filter(
    (id) => id !== deletedElementId,
  );
  const manifest = { ...syncFolder.manifest };
  if (stillReferenced || !fileDeleted) {
    // keep the entry while the file stays on disk / in use
    manifest[relPath] = { ...manifestEntry, elementIds };
  } else {
    delete manifest[relPath];
  }

  excalidrawAPI.updateScene({
    elements: excalidrawAPI.getSceneElementsIncludingDeleted().map((el) =>
      el.id === frame.id
        ? newElementWith(el, {
            customData: {
              ...el.customData,
              syncFolder: { ...syncFolder, manifest },
            },
          })
        : el,
    ),
    // background cleanup must not pollute undo history
    captureUpdate: CaptureUpdateAction.NEVER,
  });
};
