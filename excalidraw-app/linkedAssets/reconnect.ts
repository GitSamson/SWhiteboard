/**
 * Reconnect / relink flows for the "linked file assets" feature.
 *
 * File System Access permissions are per browser session, so a scene saved
 * to disk and reopened "loses" its sync frames: the persisted handles in
 * the folder registry report "prompt" and the background verifier skips
 * them silently. These helpers power the reconnect banner's buttons (both
 * must run inside a user gesture — permission prompts are otherwise
 * rejected by the browser):
 *
 * - `reconnectFolder`: re-grant permission on the persisted handle, then
 *   re-verify (rescan + re-import) the bound sync frames.
 * - `relinkFolder`: the registry entry is gone entirely (IDB cleared, other
 *   browser/profile) — let the user pick the folder again and register the
 *   new handle under the SAME folderId so the scene's `syncFolder` metadata
 *   stays valid.
 */

import { isFrameElement, newElementWith } from "@excalidraw/element";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { pickDirectory } from "./fsAccess";
import {
  ensureFolderPermission,
  getFolderEntry,
  upsertFolder,
} from "./folderRegistry";

import { verifyLinkedAssets } from "./verifier";

import { refreshConnectedFoldersAtom } from "./index";

import type { SyncFolderMeta } from "./types";

/**
 * Re-grants permission for a registered folder (user gesture required) and
 * re-verifies its sync frames. No-op when the registry entry is missing —
 * the banner shows the relink flow for that case instead.
 */
export const reconnectFolder = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
  folderId: string,
): Promise<void> => {
  const entry = await getFolderEntry(folderId);
  if (!entry) {
    return;
  }
  if (!(await ensureFolderPermission(entry.handle))) {
    excalidrawAPI.setToast({ message: "Folder permission was denied" });
    return;
  }
  await verifyLinkedAssets(excalidrawAPI);
};

/**
 * Lets the user pick the folder again and binds it to the existing
 * folderId, then re-verifies. Updates the sync frames' cached rootName when
 * the picked folder was renamed.
 */
export const relinkFolder = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
  folderId: string,
): Promise<void> => {
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await pickDirectory();
  } catch (error: any) {
    if (error?.name !== "AbortError") {
      excalidrawAPI.setToast({
        message: `Failed to link folder: ${error?.message ?? error}`,
      });
    }
    return;
  }
  if (!(await ensureFolderPermission(handle))) {
    excalidrawAPI.setToast({ message: "Folder permission was denied" });
    return;
  }

  await upsertFolder(folderId, handle);
  await refreshConnectedFoldersAtom();

  // keep the frames' cached rootName in sync with the picked folder
  const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
  const hasRootNameDrift = elements.some(
    (el) =>
      isFrameElement(el) &&
      el.customData?.syncFolder?.folderId === folderId &&
      el.customData.syncFolder.rootName !== handle.name,
  );
  if (hasRootNameDrift) {
    excalidrawAPI.updateScene({
      elements: elements.map((el) => {
        const syncFolder = el.customData?.syncFolder as
          | SyncFolderMeta
          | undefined;
        if (
          !isFrameElement(el) ||
          !syncFolder ||
          syncFolder.folderId !== folderId ||
          syncFolder.rootName === handle.name
        ) {
          return el;
        }
        return newElementWith(el, {
          customData: {
            ...el.customData,
            syncFolder: { ...syncFolder, rootName: handle.name },
          },
        });
      }),
    });
  }

  await verifyLinkedAssets(excalidrawAPI);
};
