/**
 * Auto-import for the "linked file assets" feature: image files that appear
 * in a sync frame's bound folder (and are unknown to its manifest) are
 * imported as linked image elements, laid out in a grid inside the frame.
 */

import { randomId } from "@excalidraw/common";

import {
  CaptureUpdateAction,
  isImageElement,
  newElementWith,
  newImageElement,
} from "@excalidraw/element";

import type {
  ExcalidrawFrameElement,
  ExcalidrawImageElement,
  FileId,
} from "@excalidraw/element/types";

import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { blobToDataURL } from "./convert";
import { getFolderEntry } from "./folderRegistry";
import { generateThumbnail } from "./thumbnail";

import type { LinkedFileMeta, SyncFolderMeta } from "./types";

export const GRID_PADDING = 40;
export const CELL_GAP = 20;
/** empty frames size cells as a share of the frame's smaller side */
const DEFAULT_CELL_RATIO = 0.25;
const MIN_CELL_SIZE = 80;

export interface GridCellSize {
  cellWidth: number;
  cellHeight: number;
}

/**
 * Grid cell size for newly imported images: matches the average size of the
 * images already in the frame so newcomers line up with them; falls back to
 * a share of the frame size when the frame has no images yet.
 */
export const computeImportCellSize = (
  frame: { width: number; height: number },
  childImages: Array<{ width: number; height: number }>,
): GridCellSize => {
  if (childImages.length) {
    const total = childImages.reduce(
      (acc, image) => ({
        width: acc.width + image.width,
        height: acc.height + image.height,
      }),
      { width: 0, height: 0 },
    );
    return {
      cellWidth: total.width / childImages.length + CELL_GAP,
      cellHeight: total.height / childImages.length + CELL_GAP,
    };
  }
  const base = Math.max(
    MIN_CELL_SIZE,
    Math.min(frame.width, frame.height) * DEFAULT_CELL_RATIO,
  );
  return { cellWidth: base, cellHeight: base };
};

/** number of grid columns that fit inside the frame */
export const gridColumns = (
  frame: { width: number },
  cellSize: GridCellSize,
): number =>
  Math.max(
    1,
    Math.floor((frame.width - 2 * GRID_PADDING) / cellSize.cellWidth),
  );

/**
 * Scene position of the image at grid `index`, centered within the cell's
 * inner area. Shared by the importer and the frame's reset-layout action so
 * both produce the same arrangement.
 */
export const gridPositionFor = (
  frame: { x: number; y: number },
  cellSize: GridCellSize,
  columns: number,
  index: number,
  width: number,
  height: number,
): { x: number; y: number } => ({
  x:
    frame.x +
    GRID_PADDING +
    (index % columns) * cellSize.cellWidth +
    (cellSize.cellWidth - CELL_GAP - width) / 2,
  y:
    frame.y +
    GRID_PADDING +
    Math.floor(index / columns) * cellSize.cellHeight +
    (cellSize.cellHeight - CELL_GAP - height) / 2,
});

/**
 * Frame height after growing the frame downward (if needed) so that
 * `contentBottom` fits with padding. Never shrinks the frame.
 */
export const growFrameToFit = (
  frame: { y: number; height: number },
  contentBottom: number,
): number => Math.max(frame.height, contentBottom + GRID_PADDING - frame.y);

/**
 * Scales an image down to fit a grid cell's inner area, keeping aspect
 * ratio. Never upscales. Shared by the importer and the frame's
 * reset-layout action so both produce the same image sizes.
 */
export const fitImageToCell = (
  cellSize: GridCellSize,
  width: number,
  height: number,
): { width: number; height: number } => {
  const scale = Math.min(
    1,
    (cellSize.cellWidth - CELL_GAP) / width,
    (cellSize.cellHeight - CELL_GAP) / height,
  );
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

/**
 * Imports `newFiles` (names + sizes from the verifier's directory scan) into
 * the sync frame `frameId`. Failures of individual files are skipped.
 */
export const importNewFilesIntoFrame = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
  frameId: string,
  newFiles: Array<{ name: string; size: number }>,
): Promise<void> => {
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
  const entry = await getFolderEntry(syncFolder.folderId);
  if (!entry) {
    return;
  }

  const existingChildren = sceneElements.filter(
    (el) => el.frameId === frameId && !el.isDeleted,
  ).length;
  const childImages = sceneElements.filter(
    (el) => el.frameId === frameId && !el.isDeleted && isImageElement(el),
  );
  const { cellWidth, cellHeight } = computeImportCellSize(frame, childImages);
  const cellSize = { cellWidth, cellHeight };
  const columns = gridColumns(frame, cellSize);

  const newElements: ExcalidrawImageElement[] = [];
  const newFileData: BinaryFileData[] = [];
  const manifestAdditions: SyncFolderMeta["manifest"] = {};

  for (const [index, { name, size }] of newFiles.entries()) {
    try {
      const fileHandle = await entry.handle.getFileHandle(name);
      const file = await fileHandle.getFile();
      if (!file.type.startsWith("image/")) {
        continue;
      }

      const thumbnail = await generateThumbnail(await blobToDataURL(file));
      const fileId = randomId() as FileId;

      // scale to fit the grid cell, keeping aspect ratio
      const { width, height } = fitImageToCell(
        cellSize,
        thumbnail.width,
        thumbnail.height,
      );

      const gridIndex = existingChildren + index;
      const position = gridPositionFor(
        frame,
        cellSize,
        columns,
        gridIndex,
        width,
        height,
      );

      const linkedFile: LinkedFileMeta = {
        folderId: syncFolder.folderId,
        relPath: name,
        fileSize: size,
        mimeType: file.type,
        displayName: name,
        status: "ok",
        width: thumbnail.originalWidth,
        height: thumbnail.originalHeight,
      };

      newElements.push(
        newImageElement({
          type: "image",
          x: position.x,
          y: position.y,
          width,
          height,
          fileId,
          status: "saved",
          frameId,
          customData: { linkedFile },
        }),
      );

      newFileData.push({
        id: fileId,
        mimeType: "image/webp",
        dataURL: thumbnail.dataURL,
        created: Date.now(),
        lastRetrieved: Date.now(),
      });

      manifestAdditions[name] = { size, elementIds: [] };
    } catch (error) {
      console.warn(`failed to import linked file ${name}`, error);
    }
  }

  if (!newElements.length) {
    return;
  }

  // backfill manifest elementIds
  for (const element of newElements) {
    const meta = element.customData?.linkedFile as LinkedFileMeta;
    manifestAdditions[meta.relPath].elementIds.push(element.id);
  }

  excalidrawAPI.addFiles(newFileData);

  // grow the frame downward when the new images would overflow it
  const contentBottom = Math.max(
    ...newElements.map((element) => element.y + element.height),
  );
  const frameHeight = growFrameToFit(frame, contentBottom);

  excalidrawAPI.updateScene({
    elements: [
      ...excalidrawAPI.getSceneElementsIncludingDeleted().map((element) =>
        element.id === frameId
          ? newElementWith(element, {
              height: frameHeight,
              customData: {
                ...element.customData,
                syncFolder: {
                  ...syncFolder,
                  manifest: { ...syncFolder.manifest, ...manifestAdditions },
                },
              },
            })
          : element,
      ),
      ...newElements,
    ],
    captureUpdate: CaptureUpdateAction.EVENTUALLY,
  });
};
