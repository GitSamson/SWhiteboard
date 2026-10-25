/**
 * Floating icon toolbar for a single selected image element: download the
 * original file, export the selection as a high-quality PNG, or as a PDF
 * (both rasterize linked originals at full resolution). The buttons run the
 * same registered actions as the element context menu — through the
 * imperative API's `executeAction` — so behavior stays identical.
 *
 * Self-contained: subscribes to `excalidrawAPI.onChange` and re-renders only
 * when the single-selected image element (or the viewport bits used for
 * positioning) actually changes — drags mutate elements in place, so the
 * element's `version` is the reliable change signal.
 */

import { useEffect, useState, useSyncExternalStore } from "react";

import { isImageElement } from "@excalidraw/element";
import { useI18n } from "@excalidraw/excalidraw/i18n";

import { actionDownloadOriginalImage } from "@excalidraw/excalidraw/actions/actionDownloadOriginalImage";

import { actionCopyOriginalImage } from "@excalidraw/excalidraw/actions/actionCopyOriginalImage";

import { actionToggleCropEditor } from "@excalidraw/excalidraw/actions/actionCropEditor";

import { actionExportHighestQualityPng } from "@excalidraw/excalidraw/actions/actionExportHighestQualityPng";

import { actionExportPdf } from "@excalidraw/excalidraw/actions/actionExportPdf";

import type { ExcalidrawImageElement } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { ElementToolbar, ToolbarIconButton } from "./ElementToolbar";
import {
  ToolbarCopyIcon,
  ToolbarCropIcon,
  ToolbarDownloadIcon,
  ToolbarFileTextIcon,
  ToolbarImageDownIcon,
} from "./toolbarIcons";

interface ImageToolbarSnapshot {
  element: ExcalidrawImageElement | null;
  /** `element.version` at publish time — drags mutate elements in place, so
   *  identity alone can never detect movement */
  elementVersion: number;
  /** whether the element's BinaryFiles entry is available for download */
  hasFile: boolean;
  /** file-icon placeholders link non-image files — no original image to copy */
  isPlaceholder: boolean;
  scrollX: number;
  scrollY: number;
  zoom: number;
}

const EMPTY: ImageToolbarSnapshot = {
  element: null,
  elementVersion: 0,
  hasFile: false,
  isPlaceholder: false,
  scrollX: 0,
  scrollY: 0,
  zoom: 1,
};

let snapshot: ImageToolbarSnapshot = EMPTY;
const listeners = new Set<() => void>();

const publish = (
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
): void => {
  let imageElement: ExcalidrawImageElement | null = null;
  let selectedCount = 0;
  for (const element of elements) {
    if (element.isDeleted || !appState.selectedElementIds[element.id]) {
      continue;
    }
    selectedCount++;
    if (selectedCount === 1 && isImageElement(element)) {
      imageElement = element;
    } else {
      imageElement = null;
    }
  }
  if (selectedCount !== 1) {
    imageElement = null;
  }

  const hasFile = Boolean(
    imageElement?.fileId && files[imageElement.fileId]?.dataURL,
  );
  const isPlaceholder = Boolean(
    (
      imageElement?.customData?.linkedFile as
        | { placeholder?: boolean }
        | undefined
    )?.placeholder,
  );
  const { scrollX, scrollY, zoom } = appState;
  if (
    snapshot.element === imageElement &&
    snapshot.elementVersion === (imageElement?.version ?? 0) &&
    snapshot.hasFile === hasFile &&
    snapshot.isPlaceholder === isPlaceholder &&
    snapshot.scrollX === scrollX &&
    snapshot.scrollY === scrollY &&
    snapshot.zoom === zoom.value
  ) {
    return;
  }
  snapshot = imageElement
    ? {
        element: imageElement,
        elementVersion: imageElement.version,
        hasFile,
        isPlaceholder,
        scrollX,
        scrollY,
        zoom: zoom.value,
      }
    : { ...EMPTY, scrollX, scrollY, zoom: zoom.value };
  for (const listener of Array.from(listeners)) {
    listener();
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = (): ImageToolbarSnapshot => snapshot;

export const ImageToolbarHost: React.FC<{
  excalidrawAPI: ExcalidrawImperativeAPI;
}> = ({ excalidrawAPI }) => {
  const { t } = useI18n();
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  // re-mount the onChange feed per API instance; also run once on mount so a
  // selection restored from storage shows the pill without a first interaction
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const unsubscribe = excalidrawAPI.onChange((elements, appState, files) =>
      publish(elements, appState, files),
    );
    publish(
      excalidrawAPI.getSceneElements(),
      excalidrawAPI.getAppState(),
      excalidrawAPI.getFiles(),
    );
    setMounted(true);
    return unsubscribe;
  }, [excalidrawAPI]);

  const element = snap.element;
  if (!element || !mounted) {
    return null;
  }
  const { scrollX, scrollY, zoom } = snap;

  return (
    <ElementToolbar element={element} viewport={{ scrollX, scrollY, zoom }}>
      <ToolbarIconButton
        label={t("helpDialog.cropStart")}
        onClick={() => excalidrawAPI.executeAction(actionToggleCropEditor)}
      >
        <ToolbarCropIcon />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={t("labels.copyOriginalImage")}
        disabled={!snap.hasFile || snap.isPlaceholder}
        onClick={() => excalidrawAPI.executeAction(actionCopyOriginalImage)}
      >
        <ToolbarCopyIcon />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={t("labels.downloadOriginalImage")}
        disabled={!snap.hasFile}
        onClick={() => excalidrawAPI.executeAction(actionDownloadOriginalImage)}
      >
        <ToolbarDownloadIcon />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={t("labels.exportHighestQualityPng")}
        onClick={() =>
          excalidrawAPI.executeAction(actionExportHighestQualityPng)
        }
      >
        <ToolbarImageDownIcon />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={t("labels.exportPdf")}
        onClick={() => excalidrawAPI.executeAction(actionExportPdf)}
      >
        <ToolbarFileTextIcon />
      </ToolbarIconButton>
    </ElementToolbar>
  );
};
