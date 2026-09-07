/**
 * Frame-level operations for sync frames (frame context menu):
 *
 * - showHiddenImages: un-deletes hidden linked images (board deletion only
 *   hides a linked image — the file on disk is left alone)
 * - deleteHiddenImages: deletes the files of hidden images from the bound
 *   folder for real (user-initiated, may prompt for permission)
 * - resetSyncFrameLayout: unhides everything and re-lays out the frame's
 *   linked images in a grid, restoring their cell-fitted sizes
 * - unlinkFolderLinks: strips link metadata from a folder's images without
 *   touching the disk (used when a sync frame itself is deleted)
 * - deleteFolderImages: deletes a folder's images from the board (never
 *   from disk) — user-confirmed cleanup after the sync frame was deleted
 */

import {
  CaptureUpdateAction,
  isImageElement,
  newElementWith,
} from "@excalidraw/element";

import type {
  ExcalidrawFrameElement,
  ExcalidrawImageElement,
} from "@excalidraw/element/types";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { deleteLinkedFile } from "./deletion";
import {
  computeImportCellSize,
  fitImageToCell,
  gridColumns,
  gridPositionFor,
  growFrameToFit,
} from "./importer";

import type { LinkedFileMeta, SyncFolderMeta } from "./types";

const getFrameChildren = (
  excalidrawAPI: ExcalidrawImperativeAPI,
  frameId: string,
): ExcalidrawImageElement[] =>
  excalidrawAPI
    .getSceneElementsIncludingDeleted()
    .filter(
      (el) =>
        el.frameId === frameId &&
        isImageElement(el) &&
        !!el.customData?.linkedFile,
    ) as ExcalidrawImageElement[];

const getHiddenChildren = (
  excalidrawAPI: ExcalidrawImperativeAPI,
  frameId: string,
): ExcalidrawImageElement[] =>
  getFrameChildren(excalidrawAPI, frameId).filter((el) => el.isDeleted);

/** un-deletes every hidden linked image in the frame */
export const showHiddenImages = (
  excalidrawAPI: ExcalidrawImperativeAPI,
  frameId: string,
): void => {
  const hidden = new Set(
    getHiddenChildren(excalidrawAPI, frameId).map((el) => el.id),
  );
  if (!hidden.size) {
    excalidrawAPI.setToast({ message: "No hidden images in this frame" });
    return;
  }
  excalidrawAPI.updateScene({
    elements: excalidrawAPI
      .getSceneElementsIncludingDeleted()
      .map((el) =>
        hidden.has(el.id) ? newElementWith(el, { isDeleted: false }) : el,
      ),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
};

/**
 * Deletes the on-disk files of all hidden linked images in the frame.
 * Runs in a user gesture, so a permission prompt is acceptable.
 */
export const deleteHiddenImages = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
  frameId: string,
): Promise<void> => {
  const hidden = getHiddenChildren(excalidrawAPI, frameId);
  if (!hidden.length) {
    excalidrawAPI.setToast({ message: "No hidden images in this frame" });
    return;
  }
  for (const element of hidden) {
    const meta = element.customData!.linkedFile as LinkedFileMeta;
    await deleteLinkedFile(
      excalidrawAPI,
      meta.folderId,
      meta.relPath,
      element.id,
      {
        interactive: true,
      },
    );
  }
};

/**
 * Unhides every image linked to the frame's folder — including images that
 * were dragged out of the frame — and re-lays them out in the same grid the
 * importer produces (manifest order, same cell math), restoring each image
 * to its cell-fitted size. Grows the frame downward when the grid
 * overflows it.
 */
export const resetSyncFrameLayout = (
  excalidrawAPI: ExcalidrawImperativeAPI,
  frameId: string,
): void => {
  const sceneElements = excalidrawAPI.getSceneElementsIncludingDeleted();
  const frame = sceneElements.find((el) => el.id === frameId) as
    | ExcalidrawFrameElement
    | undefined;
  const syncFolder = frame?.customData?.syncFolder as
    | SyncFolderMeta
    | undefined;
  if (!frame || !syncFolder) {
    return;
  }

  // every image linked to this folder, wherever it sits on the canvas
  const linked = sceneElements.filter(
    (el) =>
      isImageElement(el) &&
      (el.customData?.linkedFile as LinkedFileMeta | undefined)?.folderId ===
        syncFolder.folderId,
  ) as ExcalidrawImageElement[];
  if (!linked.length) {
    return;
  }

  // manifest order first; files unknown to the manifest last, by name
  const manifestOrder = new Map(
    Object.keys(syncFolder.manifest).map((relPath, index) => [relPath, index]),
  );
  const metaOf = (el: ExcalidrawImageElement) =>
    el.customData!.linkedFile as LinkedFileMeta;
  const sorted = [...linked].sort((a, b) => {
    const orderA =
      manifestOrder.get(metaOf(a).relPath) ?? Number.MAX_SAFE_INTEGER;
    const orderB =
      manifestOrder.get(metaOf(b).relPath) ?? Number.MAX_SAFE_INTEGER;
    return (
      orderA - orderB ||
      metaOf(a).displayName.localeCompare(metaOf(b).displayName)
    );
  });

  // deterministic sizing: same frame → same layout as a fresh import
  const cellSize = computeImportCellSize(frame, []);
  const columns = gridColumns(frame, cellSize);

  const layouts = new Map(
    sorted.map((el, index) => {
      const size = fitImageToCell(cellSize, el.width, el.height);
      return [
        el.id,
        {
          ...size,
          ...gridPositionFor(
            frame,
            cellSize,
            columns,
            index,
            size.width,
            size.height,
          ),
        },
      ];
    }),
  );

  const contentBottom = Math.max(
    ...sorted.map((el) => {
      const layout = layouts.get(el.id)!;
      return layout.y + layout.height;
    }),
  );
  const frameHeight = growFrameToFit(frame, contentBottom);

  excalidrawAPI.updateScene({
    elements: excalidrawAPI.getSceneElementsIncludingDeleted().map((el) => {
      if (el.id === frameId) {
        return newElementWith(el, { height: frameHeight });
      }
      const layout = layouts.get(el.id);
      return layout
        ? newElementWith(el, { ...layout, isDeleted: false, frameId })
        : el;
    }),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
};

/**
 * Strips link metadata from every image bound to `folderId`, leaving the
 * files on disk untouched. Used when the sync frame itself is deleted.
 * Not captured in undo history: undoing the frame deletion restores the
 * pre-deletion scene including the links.
 */
export const unlinkFolderLinks = (
  excalidrawAPI: ExcalidrawImperativeAPI,
  folderId: string,
): void => {
  const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
  if (
    !elements.some(
      (el) =>
        (el.customData?.linkedFile as LinkedFileMeta | undefined)?.folderId ===
        folderId,
    )
  ) {
    return;
  }
  excalidrawAPI.updateScene({
    elements: elements.map((el) => {
      const meta = el.customData?.linkedFile as LinkedFileMeta | undefined;
      if (!meta || meta.folderId !== folderId) {
        return el;
      }
      const { linkedFile: _removed, ...customData } = el.customData ?? {};
      return newElementWith(el, { customData });
    }),
    captureUpdate: CaptureUpdateAction.NEVER,
  });
};

/**
 * Deletes every image bound to `folderId` from the board (native isDeleted,
 * undoable) — user-confirmed cleanup after its sync frame was deleted.
 * The files on disk are never touched.
 */
export const deleteFolderImages = (
  excalidrawAPI: ExcalidrawImperativeAPI,
  folderId: string,
): void => {
  const doomed = new Set(
    excalidrawAPI
      .getSceneElementsIncludingDeleted()
      .filter(
        (el) =>
          isImageElement(el) &&
          !el.isDeleted &&
          (el.customData?.linkedFile as LinkedFileMeta | undefined)
            ?.folderId === folderId,
      )
      .map((el) => el.id),
  );
  if (!doomed.size) {
    return;
  }
  excalidrawAPI.updateScene({
    elements: excalidrawAPI
      .getSceneElementsIncludingDeleted()
      .map((el) =>
        doomed.has(el.id) ? newElementWith(el, { isDeleted: true }) : el,
      ),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
};
