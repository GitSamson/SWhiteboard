/**
 * Frame-level operations for sync frames (frame context menu):
 *
 * - showHiddenImages: un-deletes hidden linked images (board deletion only
 *   hides a linked image — the file on disk is left alone)
 * - deleteHiddenImages: deletes the files of hidden images from the bound
 *   folder for real (user-initiated, may prompt for permission)
 * - resetSyncFrameLayout: unhides everything and re-lays out the frame's
 *   linked images in a grid
 * - unlinkFolderLinks: strips link metadata from a folder's images without
 *   touching the disk (used when a sync frame itself is deleted)
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
import { computeImportCellSize, GRID_PADDING } from "./importer";

import type { LinkedFileMeta } from "./types";

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
 * Unhides all linked images in the frame and re-lays them out in a grid,
 * keeping their current sizes and a stable top-to-bottom, left-to-right
 * order.
 */
export const resetSyncFrameLayout = (
  excalidrawAPI: ExcalidrawImperativeAPI,
  frameId: string,
): void => {
  const frame = excalidrawAPI
    .getSceneElementsIncludingDeleted()
    .find((el) => el.id === frameId) as ExcalidrawFrameElement | undefined;
  if (!frame) {
    return;
  }
  const children = getFrameChildren(excalidrawAPI, frameId);
  if (!children.length) {
    return;
  }

  const sorted = [...children].sort((a, b) => a.y - b.y || a.x - b.x);
  const { cellWidth, cellHeight } = computeImportCellSize(frame, sorted);
  const columns = Math.max(
    1,
    Math.floor((frame.width - 2 * GRID_PADDING) / cellWidth),
  );

  const positions = new Map(
    sorted.map((el, index) => [
      el.id,
      {
        x:
          frame.x +
          GRID_PADDING +
          (index % columns) * cellWidth +
          (cellWidth - el.width) / 2,
        y:
          frame.y +
          GRID_PADDING +
          Math.floor(index / columns) * cellHeight +
          (cellHeight - el.height) / 2,
      },
    ]),
  );

  excalidrawAPI.updateScene({
    elements: excalidrawAPI.getSceneElementsIncludingDeleted().map((el) => {
      const position = positions.get(el.id);
      return position
        ? newElementWith(el, { ...position, isDeleted: false })
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
