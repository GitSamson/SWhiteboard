/**
 * Entry point of the "linked file assets" feature.
 *
 * `initLinkedAssets()` is called once from excalidraw-app/App.tsx when the
 * excalidraw API becomes available. It injects the app-layer implementation
 * into the library via setLinkedAssetsBridge() and wires up subscriptions.
 * Everything is a no-op unless the feature flag is on and the browser
 * supports the File System Access API.
 */

import { setLinkedAssetsBridge } from "@excalidraw/excalidraw";
import { setLinkedImageResolver } from "@excalidraw/excalidraw";

import { newFrameElement } from "@excalidraw/element";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { appJotaiStore } from "../app-jotai";

import { pickDirectory } from "./fsAccess";
import {
  ensureFolderPermission,
  listFolderEntries,
  registerFolder,
} from "./folderRegistry";
import { convertElementsToEmbedded, convertElementsToLinked } from "./convert";
import {
  deleteHiddenImages,
  resetSyncFrameLayout,
  showHiddenImages,
} from "./frameActions";
import {
  clearLinkedOriginalCache,
  createLinkedImageResolver,
  resolveOriginalsForExport,
} from "./originals";
import {
  connectedFoldersAtom,
  isLinkedAssetsAvailable,
  missingLinkedCountAtom,
  renameImageTargetAtom,
} from "./state";
import { enqueueConvertToLinked, startSyncEngine } from "./syncEngine";
import { verifyLinkedAssets } from "./verifier";

import type { ConnectedFolderInfo } from "./state";

export { isLinkedAssetsAvailable } from "./state";
export { verifyLinkedAssets } from "./verifier";

const SYNC_FRAME_WIDTH = 800;
const SYNC_FRAME_HEIGHT = 600;

const syncConnectedFoldersAtom = async (): Promise<void> => {
  const entries = await listFolderEntries();
  const folders: Record<string, ConnectedFolderInfo> = {};
  for (const [folderId, entry] of entries) {
    folders[folderId] = {
      folderId,
      rootName: entry.rootName,
      lastUsedAt: entry.lastUsedAt,
    };
  }
  appJotaiStore.set(connectedFoldersAtom, folders);
};

/**
 * Lets the user pick a folder, registers it, and creates a sync frame bound
 * to it at the current viewport center. User-cancel of the picker is silent;
 * other failures surface as a toast.
 */
export const createSyncFrame = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
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

  const { folderId, entry } = await registerFolder(handle);
  await syncConnectedFoldersAtom();

  const appState = excalidrawAPI.getAppState();
  const zoom = appState.zoom.value;
  const centerX = appState.width / (2 * zoom) - appState.scrollX;
  const centerY = appState.height / (2 * zoom) - appState.scrollY;

  const frame = newFrameElement({
    x: centerX - SYNC_FRAME_WIDTH / 2,
    y: centerY - SYNC_FRAME_HEIGHT / 2,
    width: SYNC_FRAME_WIDTH,
    height: SYNC_FRAME_HEIGHT,
    name: entry.rootName,
    customData: {
      syncFolder: {
        folderId,
        rootName: entry.rootName,
        manifest: {},
      },
    },
  });

  excalidrawAPI.updateScene({
    elements: [...excalidrawAPI.getSceneElementsIncludingDeleted(), frame],
  });
};

/**
 * Initializes the feature: injects the bridge into the library, loads
 * persisted folder metadata and starts the sync engine. Returns a cleanup
 * function.
 *
 * NOTE: renameImage (M5) is still a stub; registering it now keeps the
 * library↔app contract stable while the UI lands.
 */
export const initLinkedAssets = (
  excalidrawAPI: ExcalidrawImperativeAPI,
): (() => void) => {
  if (!isLinkedAssetsAvailable()) {
    return () => {};
  }

  setLinkedAssetsBridge({
    // drop/toolbar inserts become linked files; paste stays embedded
    onImagesInserted: (source, _files, elements) => {
      if (source !== "paste") {
        enqueueConvertToLinked(excalidrawAPI, elements);
      }
    },
    // hi-res originals for canvas rendering / export
    resolveOriginal: createLinkedImageResolver(excalidrawAPI),
    resolveOriginalsForExport: (files) =>
      resolveOriginalsForExport(excalidrawAPI, files),
    // rename flow: opens the app-layer rename dialog
    renameImage: (element) => {
      appJotaiStore.set(renameImageTargetAtom, element.id);
    },
    // linked ↔ embedded conversion
    convertToLinked: (elements) =>
      convertElementsToLinked(excalidrawAPI, elements),
    convertToEmbedded: (elements) =>
      convertElementsToEmbedded(excalidrawAPI, elements),
    // sync frame context menu operations
    showHiddenImages: (frame) => showHiddenImages(excalidrawAPI, frame.id),
    deleteHiddenImages: (frame) => deleteHiddenImages(excalidrawAPI, frame.id),
    resetSyncFrameLayout: (frame) =>
      resetSyncFrameLayout(excalidrawAPI, frame.id),
  });

  // the element package's image cache asks this resolver before decoding a
  // linked image's thumbnail dataURL
  setLinkedImageResolver(createLinkedImageResolver(excalidrawAPI));

  // keep the missing-linked counter atom in sync for the banner UI
  const unsubscribeMissingCount = excalidrawAPI.onChange((elements) => {
    const count = elements.filter(
      (el) => !el.isDeleted && el.customData?.linkedFile?.status === "missing",
    ).length;
    if (appJotaiStore.get(missingLinkedCountAtom) !== count) {
      appJotaiStore.set(missingLinkedCountAtom, count);
    }
  });

  void syncConnectedFoldersAtom();

  const stopSyncEngine = startSyncEngine(excalidrawAPI);

  // run the first verification once the initial scene has been applied
  let initialVerifyDone = false;
  const unsubscribeInitialVerify = excalidrawAPI.onChange(() => {
    if (initialVerifyDone) {
      return;
    }
    initialVerifyDone = true;
    unsubscribeInitialVerify();
    // let files/scene settle before hitting the disk
    setTimeout(() => void verifyLinkedAssets(excalidrawAPI), 1000);
  });

  // re-verify linked files whenever the window regains focus
  const onWindowFocus = () => {
    void verifyLinkedAssets(excalidrawAPI);
  };
  window.addEventListener("focus", onWindowFocus);

  return () => {
    window.removeEventListener("focus", onWindowFocus);
    unsubscribeInitialVerify();
    stopSyncEngine();
    unsubscribeMissingCount();
    setLinkedImageResolver(null);
    clearLinkedOriginalCache();
    setLinkedAssetsBridge(null);
  };
};
