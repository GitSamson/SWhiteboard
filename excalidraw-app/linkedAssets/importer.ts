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

/**
 * Grid cell size for newly imported images: matches the average size of the
 * images already in the frame so newcomers line up with them; falls back to
 * a share of the frame size when the frame has no images yet.
 */
export const computeImportCellSize = (
  frame: { width: number; height: number },
  childImages: Array<{ width: number; height: number }>,
): { cellWidth: number; cellHeight: number } => {
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
  const innerWidth = cellWidth - CELL_GAP;
  const innerHeight = cellHeight - CELL_GAP;
  const columns = Math.max(
    1,
    Math.floor((frame.width - 2 * GRID_PADDING) / cellWidth),
  );

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
      const scale = Math.min(
        1,
        innerWidth / thumbnail.width,
        innerHeight / thumbnail.height,
      );
      const width = Math.max(1, Math.round(thumbnail.width * scale));
      const height = Math.max(1, Math.round(thumbnail.height * scale));

      const gridIndex = existingChildren + index;
      const cellX = frame.x + GRID_PADDING + (gridIndex % columns) * cellWidth;
      const cellY =
        frame.y + GRID_PADDING + Math.floor(gridIndex / columns) * cellHeight;

      const linkedFile: LinkedFileMeta = {
        folderId: syncFolder.folderId,
        relPath: name,
        fileSize: size,
        mimeType: file.type,
        displayName: name,
        status: "ok",
      };

      newElements.push(
        newImageElement({
          type: "image",
          x: cellX + (innerWidth - width) / 2,
          y: cellY + (innerHeight - height) / 2,
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

  excalidrawAPI.updateScene({
    elements: [
      ...excalidrawAPI.getSceneElementsIncludingDeleted().map((element) =>
        element.id === frameId
          ? newElementWith(element, {
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
