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

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { appJotaiStore } from "../app-jotai";

import { getFolderEntry, queryFolderPermission } from "./folderRegistry";
import { folderConnectionStatusAtom, isLinkedAssetsAvailable } from "./state";

import type { FolderConnectionStatus } from "./state";
import type { SyncFolderMeta } from "./types";

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
