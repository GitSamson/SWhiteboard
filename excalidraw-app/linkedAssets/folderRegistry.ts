/**
 * App-level registry of user-authorized folders for the "linked file assets"
 * feature. Maps folderId → FolderRegistryEntry in a dedicated IndexedDB
 * store. FileSystemDirectoryHandle objects are structured-cloneable, so the
 * handle itself is persisted and reused across sessions (permissions still
 * need to be re-granted per session, see ensureFolderPermission).
 */

import { createStore, del, entries, get, set } from "idb-keyval";

import { STORAGE_KEYS } from "../app_constants";

import type { FolderRegistryEntry } from "./types";

const linkedAssetsStore = createStore(
  STORAGE_KEYS.IDB_LINKED_ASSETS_DB,
  STORAGE_KEYS.IDB_LINKED_ASSETS_STORE,
);

export const registerFolder = async (
  handle: FileSystemDirectoryHandle,
): Promise<{ folderId: string; entry: FolderRegistryEntry }> => {
  const folderId = crypto.randomUUID();
  const entry: FolderRegistryEntry = {
    handle,
    rootName: handle.name,
    lastUsedAt: Date.now(),
  };
  await set(folderId, entry, linkedAssetsStore);
  return { folderId, entry };
};

export const getFolderEntry = async (
  folderId: string,
): Promise<FolderRegistryEntry | undefined> => {
  return get<FolderRegistryEntry>(folderId, linkedAssetsStore);
};

export const listFolderEntries = async (): Promise<
  Array<[string, FolderRegistryEntry]>
> => {
  return entries<string, FolderRegistryEntry>(linkedAssetsStore);
};

export const touchFolder = async (folderId: string): Promise<void> => {
  const entry = await getFolderEntry(folderId);
  if (entry) {
    await set(
      folderId,
      { ...entry, lastUsedAt: Date.now() },
      linkedAssetsStore,
    );
  }
};

export const unregisterFolder = async (folderId: string): Promise<void> => {
  return del(folderId, linkedAssetsStore);
};

/** current permission state; "granted" when the API is unavailable (legacy) */
export const queryFolderPermission = async (
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState> => {
  if (typeof handle.queryPermission === "function") {
    return handle.queryPermission({ mode: "readwrite" });
  }
  return "granted";
};

/**
 * Makes sure we hold readwrite permission for `handle`. Must be called from
 * a user-gesture context when the current state is "prompt" — browsers reject
 * silent permission requests.
 */
export const ensureFolderPermission = async (
  handle: FileSystemDirectoryHandle,
): Promise<boolean> => {
  const state = await queryFolderPermission(handle);
  if (state === "granted") {
    return true;
  }
  if (typeof handle.requestPermission === "function") {
    return (
      (await handle.requestPermission({ mode: "readwrite" })) === "granted"
    );
  }
  return false;
};
