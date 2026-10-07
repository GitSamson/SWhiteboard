/**
 * Import a dropped/opened video file as an embeddable element whose binary is
 * stored in the scene BinaryFiles and whose link (`appfile:video/<fileId>`)
 * is rendered by the app-layer VideoEmbed via `renderEmbeddable`.
 */

import { newEmbeddableElement } from "@excalidraw/element";
import { generateIdFromFile } from "@excalidraw/excalidraw/data/blob";
import { t } from "@excalidraw/excalidraw/i18n";

import type { FileId } from "@excalidraw/element/types";
import type {
  BinaryFileData,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { blobToDataURL } from "../linkedAssets/convert";

export interface VideoSourceFileMeta {
  fileId: FileId;
  kind: "video";
  name: string;
}

export const VIDEO_EMBEDDABLE_WIDTH = 640;
export const VIDEO_EMBEDDABLE_HEIGHT = 360;

const VIDEO_EXTENSIONS = [
  ".mp4",
  ".webm",
  ".mov",
  ".m4v",
  ".mkv",
  ".ogv",
  ".3gp",
  ".3gpp",
  ".hevc",
  ".h265",
];

/** mobile pickers report wildly varying MIME types (often empty) — accept any
 *  video/* MIME and fall back to common extensions */
export const isSupportedVideoFile = (file: File): boolean =>
  file.type.startsWith("video/") ||
  VIDEO_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));

export const importVideoFile = async (
  file: File,
  pos: { x: number; y: number },
  excalidrawAPI: ExcalidrawImperativeAPI,
): Promise<void> => {
  if (!isSupportedVideoFile(file)) {
    excalidrawAPI.setToast({ message: t("mediaImport.loadError") });
    return;
  }

  let dataURL: DataURL;
  let fileId: FileId;
  try {
    [dataURL, fileId] = await Promise.all([
      blobToDataURL(file),
      generateIdFromFile(file),
    ]);
  } catch (error) {
    excalidrawAPI.setToast({ message: t("mediaImport.loadError") });
    return;
  }

  excalidrawAPI.addFiles([
    {
      mimeType: (file.type || "video/mp4") as BinaryFileData["mimeType"],
      id: fileId,
      dataURL,
      created: Date.now(),
      lastRetrieved: Date.now(),
    },
  ]);

  const element = newEmbeddableElement({
    type: "embeddable",
    x: pos.x,
    y: pos.y,
    width: VIDEO_EMBEDDABLE_WIDTH,
    height: VIDEO_EMBEDDABLE_HEIGHT,
    link: `appfile:video/${fileId}`,
    customData: {
      sourceFile: { fileId, kind: "video", name: file.name },
    },
  });

  excalidrawAPI.updateScene({
    elements: [...excalidrawAPI.getSceneElements(), element],
    appState: { selectedElementIds: { [element.id]: true } },
  });
};
