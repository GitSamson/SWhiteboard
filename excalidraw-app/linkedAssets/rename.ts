/**
 * Rename flow for linked images: renames the file on disk (same directory),
 * then updates the element's customData and the bound frame's manifest.
 *
 * Conflicts (target name already exists on disk or in the manifest) and
 * invalid names are rejected — the element keeps its previous name.
 */

import {
  CaptureUpdateAction,
  isImageElement,
  newElementWith,
} from "@excalidraw/element";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  getFileHandleByRelPath,
  renameFileByRelPath,
  sanitizeFileName,
} from "./fsAccess";
import { ensureFolderPermission, getFolderEntry } from "./folderRegistry";
import { invalidateLinkedOriginal } from "./originals";

import type { LinkedFileMeta, SyncFolderMeta } from "./types";

/**
 * Renames the linked file of the image element `elementId` to `newName`
 * (extension is preserved from the current file). Returns true on success.
 */
export const renameLinkedImage = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
  elementId: string,
  newName: string,
): Promise<boolean> => {
  const sceneElements = excalidrawAPI.getSceneElementsIncludingDeleted();
  const element = sceneElements.find((el) => el.id === elementId);
  const meta = element?.customData?.linkedFile as LinkedFileMeta | undefined;
  if (!element || !meta) {
    return false;
  }

  const entry = await getFolderEntry(meta.folderId);
  if (!entry) {
    excalidrawAPI.setToast({ message: "Linked folder is not connected" });
    return false;
  }
  if (!(await ensureFolderPermission(entry.handle))) {
    excalidrawAPI.setToast({
      message: `Folder "${entry.rootName}" needs permission to rename files`,
    });
    return false;
  }

  // preserve the original extension when the user dropped it
  const currentExt = meta.relPath.includes(".")
    ? meta.relPath.slice(meta.relPath.lastIndexOf("."))
    : "";
  let target = sanitizeFileName(newName.trim());
  if (currentExt && !target.toLowerCase().endsWith(currentExt.toLowerCase())) {
    target = `${target}${currentExt}`;
  }

  const segments = meta.relPath.split("/");
  segments[segments.length - 1] = target;
  const newRelPath = segments.join("/");

  if (newRelPath === meta.relPath) {
    return true; // nothing to do
  }

  // reject when the target name is taken on disk or in the manifest
  try {
    await getFileHandleByRelPath(entry.handle, newRelPath);
    excalidrawAPI.setToast({
      message: `A file named "${target}" already exists`,
    });
    return false;
  } catch {
    // doesn't exist — good
  }
  const frame = sceneElements.find((el) => el.id === element.frameId);
  const syncFolder = frame?.customData?.syncFolder as
    | SyncFolderMeta
    | undefined;
  if (syncFolder?.manifest[newRelPath]) {
    excalidrawAPI.setToast({
      message: `A file named "${target}" already exists`,
    });
    return false;
  }

  await renameFileByRelPath(entry.handle, meta.relPath, target);

  if (isImageElement(element) && element.fileId) {
    // path changed; drop any cached original keyed by fileId
    invalidateLinkedOriginal(element.fileId);
  }

  excalidrawAPI.updateScene({
    elements: excalidrawAPI.getSceneElementsIncludingDeleted().map((el) => {
      if (el.id === elementId) {
        const nextMeta: LinkedFileMeta = {
          ...meta,
          relPath: newRelPath,
          displayName: newRelPath.split("/").pop() ?? newRelPath,
        };
        return newElementWith(el, {
          customData: { ...el.customData, linkedFile: nextMeta },
        });
      }
      if (syncFolder && frame && el.id === frame.id) {
        const manifest = { ...syncFolder.manifest };
        const manifestEntry = manifest[meta.relPath];
        if (manifestEntry) {
          delete manifest[meta.relPath];
          manifest[newRelPath] = manifestEntry;
          return newElementWith(el, {
            customData: {
              ...el.customData,
              syncFolder: { ...syncFolder, manifest },
            },
          });
        }
      }
      return el;
    }),
    captureUpdate: CaptureUpdateAction.EVENTUALLY,
  });

  return true;
};
