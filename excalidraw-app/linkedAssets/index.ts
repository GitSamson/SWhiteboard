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
import { setThumbnailResolver } from "@excalidraw/excalidraw";

import { debounce } from "@excalidraw/common";

import throttle from "lodash.throttle";

import { isFrameElement, newFrameElement } from "@excalidraw/element";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { appJotaiStore } from "../app-jotai";

import { pickDirectory } from "./fsAccess";
import {
  ensureFolderPermission,
  listFolderEntries,
  registerFolder,
} from "./folderRegistry";
import { convertElementsToEmbedded, convertElementsToLinked } from "./convert";
import { resetSyncFrameLayout, showHiddenImages } from "./frameActions";
import {
  clearLinkedOriginalCache,
  createLinkedImageResolver,
  resolveOriginalsForExport,
} from "./originals";
import { refreshFolderConnectionStatuses } from "./connectionStatus";
import { isWholesaleSceneReplacement } from "./sceneReplace";
import {
  connectedFoldersAtom,
  deleteHiddenImagesTargetAtom,
  isLinkedAssetsAvailable,
  missingLinkedCountAtom,
  renameImageTargetAtom,
} from "./state";
import { enqueueConvertToLinked, startSyncEngine } from "./syncEngine";
import { createThumbnailResolver } from "./thumbnailResolver";
import { enqueueThumbnailGeneration } from "./thumbnailStore";
import { verifyLinkedAssets, verifySyncFrame } from "./verifier";

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
 * Re-reads the folder registry into `connectedFoldersAtom`. Exported for
 * the reconnect flows (relink registers a new handle under an existing
 * folderId and needs the panel/banner metadata refreshed).
 */
export const refreshConnectedFoldersAtom = syncConnectedFoldersAtom;

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

  // import the folder's current images right away instead of waiting for
  // the next load/focus-triggered verification
  void verifyLinkedAssets(excalidrawAPI);
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
  // thumbnail-first rendering is generic performance infrastructure — it
  // helps embedded images too, so register it even when the File System
  // Access API (and thus the linked-assets feature) is unavailable
  setThumbnailResolver(createThumbnailResolver(excalidrawAPI));

  if (!isLinkedAssetsAvailable()) {
    return () => {
      setThumbnailResolver(null);
    };
  }

  setLinkedAssetsBridge({
    // only images that land INSIDE a live sync frame become linked files;
    // paste is always embedded, and drops/toolbar inserts outside any sync
    // frame stay embedded too (no implicit folder writes)
    onImagesInserted: (source, files, elements) => {
      const syncFrameIds = new Set(
        excalidrawAPI
          .getSceneElements()
          .filter((el) => isFrameElement(el) && el.customData?.syncFolder)
          .map((el) => el.id),
      );
      const toLink =
        source === "paste"
          ? []
          : elements.filter((el) => el.frameId && syncFrameIds.has(el.frameId));
      if (toLink.length) {
        enqueueConvertToLinked(excalidrawAPI, toLink);
      }
      // images staying embedded: build thumbnail tiers in the background so
      // the render cache can decode thumbnails instead of originals next time
      const linkedIds = new Set(toLink.map((el) => el.id));
      for (const element of elements) {
        if (linkedIds.has(element.id)) {
          continue;
        }
        const fileData = element.fileId && files[element.fileId];
        if (fileData) {
          enqueueThumbnailGeneration(fileData.id, fileData.dataURL);
        }
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
    deleteHiddenImages: (frame) => {
      // opens the confirmation dialog; the dialog performs the deletion
      appJotaiStore.set(deleteHiddenImagesTargetAtom, frame.id);
    },
    resetSyncFrameLayout: (frame) =>
      resetSyncFrameLayout(excalidrawAPI, frame.id),
    refreshSyncFrame: (frame) => void verifySyncFrame(excalidrawAPI, frame.id),
  });

  // the element package's image cache asks this resolver before decoding a
  // linked image's full-resolution original (quality upgrades and export;
  // plain cache fills are served by the thumbnail resolver above)
  setLinkedImageResolver(createLinkedImageResolver(excalidrawAPI));

  // keep the missing-linked counter atom in sync for the banner UI. Runs in
  // the throttled scene-replace check below — counting is O(N) over all
  // elements, so it must not run on every scene change.
  const updateMissingCount = (elements: readonly ExcalidrawElement[]) => {
    const count = elements.filter(
      (el) => !el.isDeleted && el.customData?.linkedFile?.status === "missing",
    ).length;
    if (appJotaiStore.get(missingLinkedCountAtom) !== count) {
      appJotaiStore.set(missingLinkedCountAtom, count);
    }
  };

  void syncConnectedFoldersAtom();
  void refreshFolderConnectionStatuses(excalidrawAPI);

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

  // re-verify when the whole scene is replaced (opening a .excalidraw file,
  // dropping one onto the canvas): the library swaps the scene internally,
  // so the replacement is detected from the scene change stream instead.
  // Read-only: loading a scene must never write to disk.
  //
  // The detector is O(N) per run (it builds an id→element Map of the whole
  // scene), so it is rate-limited to ~1/s — wholesale replacement is a
  // low-frequency event and a ≤1s detection delay is imperceptible. Routine
  // edits (which fire onChange on every gesture frame) only record the
  // latest elements between runs.
  let latestElements: readonly ExcalidrawElement[] | null = null;
  let baselineElements: readonly ExcalidrawElement[] | null = null;
  const scheduleSceneReloadVerify = debounce(() => {
    void verifyLinkedAssets(excalidrawAPI);
    void refreshFolderConnectionStatuses(excalidrawAPI);
  }, 500);
  const runSceneReplaceCheck = throttle(() => {
    const elements = latestElements;
    if (!elements) {
      return;
    }
    updateMissingCount(elements);
    const replaced = isWholesaleSceneReplacement(baselineElements, elements);
    baselineElements = elements;
    if (replaced) {
      scheduleSceneReloadVerify();
    }
  }, 1000);
  const unsubscribeSceneReplace = excalidrawAPI.onChange((elements) => {
    latestElements = elements;
    runSceneReplaceCheck();
  });

  // re-verify linked files whenever the window regains focus
  const onWindowFocus = () => {
    void verifyLinkedAssets(excalidrawAPI);
    void refreshFolderConnectionStatuses(excalidrawAPI);
  };
  window.addEventListener("focus", onWindowFocus);

  return () => {
    window.removeEventListener("focus", onWindowFocus);
    unsubscribeInitialVerify();
    unsubscribeSceneReplace();
    runSceneReplaceCheck.cancel();
    scheduleSceneReloadVerify.cancel();
    stopSyncEngine();
    setThumbnailResolver(null);
    setLinkedImageResolver(null);
    clearLinkedOriginalCache();
    setLinkedAssetsBridge(null);
  };
};
