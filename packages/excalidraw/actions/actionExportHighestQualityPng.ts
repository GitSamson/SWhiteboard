import { DEFAULT_EXPORT_PADDING } from "@excalidraw/common";

import {
  CaptureUpdateAction,
  getCommonBounds,
  isImageElement,
} from "@excalidraw/element";

import { canvasToBlob } from "../data/blob";

import { downloadIcon } from "../components/icons";

import { t } from "../i18n";

import { getLinkedAssetsBridge } from "../linkedAssetsBridge";
import { exportToCanvas } from "../scene/export";

import { register } from "./register";

import type { BinaryFiles } from "../types";

/** hard ceiling for the exported canvas — bigger canvases fail in canvasToBlob */
const MAX_EXPORT_DIMENSION = 8192;

export const actionExportHighestQualityPng = register({
  name: "exportHighestQualityPng",
  label: "labels.exportHighestQualityPng",
  icon: downloadIcon,
  viewMode: true,
  trackEvent: { category: "export" },
  keywords: ["image", "download", "export", "png", "high quality"],
  perform: async (elements, appState, _, app) => {
    const selectedElements = app.scene.getSelectedElements({
      selectedElementIds: appState.selectedElementIds,
      includeBoundTextElement: true,
    });

    const exportPadding = DEFAULT_EXPORT_PADDING;

    // start from the baseline 2x export and raise the scale for linked
    // images whose originals are larger than their on-canvas footprint
    let scale = 2;
    for (const element of selectedElements) {
      if (isImageElement(element) && element.width > 0) {
        const originalWidth = element.customData?.linkedFile?.width;
        if (typeof originalWidth === "number" && originalWidth > 0) {
          scale = Math.max(scale, originalWidth / element.width);
        }
      }
    }
    scale = Math.min(8, Math.max(2, scale));

    // make sure the resulting canvas fits within browser limits
    const [, , boundsWidth, boundsHeight] = getCommonBounds(selectedElements);
    const exportWidth = boundsWidth + exportPadding * 2;
    const exportHeight = boundsHeight + exportPadding * 2;
    if (exportWidth > 0 && exportHeight > 0) {
      scale = Math.min(
        scale,
        MAX_EXPORT_DIMENSION / exportWidth,
        MAX_EXPORT_DIMENSION / exportHeight,
      );
    }

    // only resolve files referenced by the selection (avoid reading the
    // disk for the rest of the scene); linked thumbnails get swapped for
    // their originals when the bridge is available
    const fileIds = new Set<string>();
    for (const element of selectedElements) {
      if (isImageElement(element) && element.fileId) {
        fileIds.add(element.fileId);
      }
    }
    const subsetFiles: BinaryFiles = {};
    for (const fileId of fileIds) {
      const fileData = app.files[fileId];
      if (fileData) {
        subsetFiles[fileId] = fileData;
      }
    }
    const files =
      (await getLinkedAssetsBridge()?.resolveOriginalsForExport(subsetFiles)) ??
      subsetFiles;

    try {
      const canvas = await exportToCanvas(
        selectedElements,
        { ...appState, exportScale: scale },
        files,
        {
          exportBackground: appState.exportBackground,
          exportPadding,
          viewBackgroundColor: appState.viewBackgroundColor,
        },
      );

      const blob = await canvasToBlob(canvas);

      const doc = app.ownerDocument;
      const objectUrl = app.ownerWindow.URL.createObjectURL(blob);
      const anchor = doc.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${appState.name?.trim() || "untitled"}-高清.png`;
      doc.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      app.ownerWindow.URL.revokeObjectURL(objectUrl);
    } catch (error: any) {
      console.warn(error);
      app.setToast({
        message:
          error?.name === "CANVAS_POSSIBLY_TOO_BIG"
            ? t("canvasError.canvasTooBig")
            : "Failed to export PNG.",
      });
    }

    return {
      captureUpdate: CaptureUpdateAction.NEVER,
    };
  },
  predicate: (elements, appState, _, app) => {
    const selectedElements = app.scene.getSelectedElements(appState);
    return selectedElements.length > 0;
  },
});
