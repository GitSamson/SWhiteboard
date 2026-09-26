/**
 * Connection-status derivation for sync folders.
 *
 * File System Access permissions are per-session: after reopening a saved
 * .excalidraw file the persisted handles report "prompt" until the user
 * re-grants access from a user gesture. The background verifier silently
 * skips such folders, so this module is what tells the UI that a folder
 * `needs-permission` (reconnect possible), is `connected`, or has no handle
 * in the registry at all (`handle-missing` — the link cannot be recovered
 * automatically).
 */

import { isImageElement } from "@excalidraw/element";

import type { FileId } from "@excalidraw/element/types";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { appJotaiStore } from "../app-jotai";

import { getFolderEntry, queryFolderPermission } from "./folderRegistry";
import { folderConnectionStatusAtom, isLinkedAssetsAvailable } from "./state";

import type { FolderConnectionStatus } from "./state";
import type { SyncFolderMeta } from "./types";
import type { LinkedFileMeta } from "./types";

export const getFolderConnectionStatus = async (
  folderId: string,
): Promise<FolderConnectionStatus> => {
  const entry = await getFolderEntry(folderId);
  if (!entry) {
    return "handle-missing";
  }
  return (await queryFolderPermission(entry.handle)) === "granted"
    ? "connected"
    : "needs-permission";
};

/**
 * Re-derives the connection status of every sync frame on the scene and
 * stores the result in `folderConnectionStatusAtom`. Read-only (queries
 * permissions, never prompts).
 */
export const refreshFolderConnectionStatuses = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
): Promise<void> => {
  if (!isLinkedAssetsAvailable()) {
    return;
  }
  const folderIds = new Set<string>();
  for (const element of excalidrawAPI.getSceneElementsIncludingDeleted()) {
    const syncFolder = element.customData?.syncFolder as
      | SyncFolderMeta
      | undefined;
    if (element.type === "frame" && !element.isDeleted && syncFolder) {
      folderIds.add(syncFolder.folderId);
    }
  }
  const statuses: Record<string, FolderConnectionStatus> = {};
  for (const folderId of folderIds) {
    try {
      statuses[folderId] = await getFolderConnectionStatus(folderId);
    } catch (error) {
      console.warn(`failed to query connection status for ${folderId}`, error);
    }
  }
  appJotaiStore.set(folderConnectionStatusAtom, statuses);
};

/**
 * Counts how many of the given fileIds belong to linked images whose
 * originals can't currently be read — the folder handle is missing from the
 * registry or its permission isn't granted. Read-only (queries, never
 * prompts). Used to warn before an export silently falls back to thumbnails.
 */
export const getUnavailableLinkedOriginalCount = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
  fileIds: readonly FileId[],
): Promise<number> => {
  if (!isLinkedAssetsAvailable() || !fileIds.length) {
    return 0;
  }
  const folderIdByFileId = new Map<string, string>();
  for (const element of excalidrawAPI.getSceneElementsIncludingDeleted()) {
    if (
      isImageElement(element) &&
      element.fileId &&
      element.customData?.linkedFile
    ) {
      folderIdByFileId.set(
        element.fileId,
        (element.customData.linkedFile as LinkedFileMeta).folderId,
      );
    }
  }
  const readableByFolderId = new Map<string, boolean>();
  let unavailable = 0;
  for (const fileId of fileIds) {
    const folderId = folderIdByFileId.get(fileId as string);
    if (!folderId) {
      // not a linked image (embedded, or metadata stripped) — nothing to check
      continue;
    }
    if (!readableByFolderId.has(folderId)) {
      const entry = await getFolderEntry(folderId);
      readableByFolderId.set(
        folderId,
        !!entry && (await queryFolderPermission(entry.handle)) === "granted",
      );
    }
    if (!readableByFolderId.get(folderId)) {
      unavailable++;
    }
  }
  return unavailable;
};
