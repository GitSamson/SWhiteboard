/**
 * Jotai state for the "linked file assets" feature. Atoms live next to the
 * feature (project convention) and jotai is only imported through
 * ../app-jotai.
 */

import { atom } from "../app-jotai";

import { isFileSystemAccessSupported } from "./fsAccess";

/** feature flag from env (string compare, see vite-env.d.ts) */
export const LINKED_ASSETS_FEATURE_ENABLED =
  import.meta.env.VITE_APP_ENABLE_LINKED_FILES === "true";

/** flag + browser capability, evaluated once */
export const isLinkedAssetsAvailable = (): boolean => {
  return (
    LINKED_ASSETS_FEATURE_ENABLED &&
    typeof window !== "undefined" &&
    isFileSystemAccessSupported()
  );
};

export const linkedAssetsSupportedAtom = atom(isLinkedAssetsAvailable());

export interface ConnectedFolderInfo {
  folderId: string;
  rootName: string;
  lastUsedAt: number;
}

/** metadata of registered folders (handles stay in folderRegistry/IDB) */
export const connectedFoldersAtom = atom<Record<string, ConnectedFolderInfo>>(
  {},
);

/**
 * Live connection status of each sync frame's folder, derived from the
 * folder registry + permission state and refreshed after verify runs,
 * scene reloads, window focus, and reconnects.
 */
export type FolderConnectionStatus =
  | "connected"
  | "needs-permission"
  | "handle-missing";

export const folderConnectionStatusAtom = atom<
  Record<string, FolderConnectionStatus>
>({});

/** number of linked image elements currently marked "missing" */
export const missingLinkedCountAtom = atom(0);

/** id of the linked image element being renamed, null when dialog closed */
export const renameImageTargetAtom = atom<string | null>(null);

/** id of the sync frame whose hidden images are pending deletion confirm */
export const deleteHiddenImagesTargetAtom = atom<string | null>(null);

export interface OrphanedSyncFolder {
  folderId: string;
  rootName: string;
  /** files associated with the deleted sync frame */
  relPaths: string[];
}

/** set when a sync frame with linked files was deleted; null when dismissed */
export const orphanedSyncFolderAtom = atom<OrphanedSyncFolder | null>(null);
