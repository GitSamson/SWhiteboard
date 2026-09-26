import { DEFAULT_EXPORT_PADDING } from "@excalidraw/common";

import { getCommonBounds, isImageElement } from "@excalidraw/element";

import type { FileId } from "@excalidraw/element/types";

import { t } from "../i18n";

import { getLinkedAssetsBridge } from "../linkedAssetsBridge";

import type { AppClassProperties, AppState, BinaryFiles } from "../types";

/** hard ceilings for the exported canvas — bigger canvases fail downstream */
const MAX_EXPORT_SIDE = 16384;
const MAX_EXPORT_AREA = 2 ** 26; // 67108864 px²

export type OriginalQualityExport = {
  selectedElements: ReturnType<
    AppClassProperties["scene"]["getSelectedElements"]
  >;
  /** export scale so linked originals render at least 1:1 (canvas limits permitting) */
  scale: number;
  files: BinaryFiles;
  /** unscaled export dimensions (bounds + padding), for PDF page sizing */
  exportWidth: number;
  exportHeight: number;
};

/**
 * Shared preparation for the "original quality" export actions (hi-res PNG,
 * PDF): selected elements, an export scale that keeps linked originals at
 * native resolution, and a files map with linked thumbnails swapped for
 * their originals (when the linked-assets bridge is available).
 */
export const prepareOriginalQualityExport = async (
  app: AppClassProperties,
  appState: AppState,
): Promise<OriginalQualityExport> => {
  const selectedElements = app.scene.getSelectedElements({
    selectedElementIds: appState.selectedElementIds,
    includeBoundTextElement: true,
  });

  const exportPadding = DEFAULT_EXPORT_PADDING;

  // baseline 2x export, raised so every linked original renders at least 1:1
  // (embedded images have no recorded natural size and keep the baseline)
  let scale = 2;
  for (const element of selectedElements) {
    if (isImageElement(element) && element.width > 0) {
      const originalWidth = element.customData?.linkedFile?.width;
      if (typeof originalWidth === "number" && originalWidth > 0) {
        scale = Math.max(scale, originalWidth / element.width);
      }
    }
  }

  // only canvas feasibility limits the scale: side length and total area
  // (getCommonBounds returns absolute [minX, minY, maxX, maxY] — the page
  // must use the *extents*, not the raw maxima, or far-from-origin
  // selections export as distorted strips)
  const [minX, minY, maxX, maxY] = getCommonBounds(selectedElements);
  const exportWidth = Math.max(0, maxX - minX) + exportPadding * 2;
  const exportHeight = Math.max(0, maxY - minY) + exportPadding * 2;
  if (exportWidth > 0 && exportHeight > 0) {
    scale = Math.min(
      scale,
      MAX_EXPORT_SIDE / exportWidth,
      MAX_EXPORT_SIDE / exportHeight,
      Math.sqrt(MAX_EXPORT_AREA / (exportWidth * exportHeight)),
    );
  }

  // only resolve files referenced by the selection (avoid reading the
  // disk for the rest of the scene); linked thumbnails get swapped for
  // their originals when the bridge is available
  const linkedFileIds: FileId[] = [];
  const fileIds = new Set<string>();
  for (const element of selectedElements) {
    if (isImageElement(element) && element.fileId) {
      fileIds.add(element.fileId);
      if (element.customData?.linkedFile) {
        linkedFileIds.push(element.fileId);
      }
    }
  }
  const subsetFiles: BinaryFiles = {};
  for (const fileId of fileIds) {
    const fileData = app.files[fileId];
    if (fileData) {
      subsetFiles[fileId] = fileData;
    }
  }
  const bridge = getLinkedAssetsBridge();
  const files =
    (await bridge?.resolveOriginalsForExport(subsetFiles)) ?? subsetFiles;

  // originals that can't be read would silently degrade to thumbnails —
  // say so instead
  const unavailable = bridge?.getUnavailableLinkedOriginalCount
    ? await bridge.getUnavailableLinkedOriginalCount(linkedFileIds)
    : 0;
  if (unavailable > 0) {
    app.setToast({
      message: t("labels.linkedOriginalsUnavailable", { count: unavailable }),
    });
  }

  return { selectedElements, scale, files, exportWidth, exportHeight };
};
