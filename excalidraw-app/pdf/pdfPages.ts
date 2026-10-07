/**
 * Helpers to turn server-rasterized PDF pages (see vitePdfPlugin.ts) into
 * regular image elements on the board.
 */

import { newImageElement } from "@excalidraw/element";
import { generateIdFromFile } from "@excalidraw/excalidraw/data/blob";

import type { ExcalidrawImageElement, FileId } from "@excalidraw/element/types";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { blobToDataURL } from "../linkedAssets/convert";

import { getImageBlobDimensions } from "./imageDims";

/** scene-units width of inserted page images */
export const PAGE_IMAGE_WIDTH = 720;
/** vertical gap between inserted page images, scene units */
export const PAGE_IMAGE_GAP = 24;

const extensionFor = (mimeType: string): string => {
  if (mimeType === "image/webp") {
    return "webp";
  }
  if (mimeType === "image/png") {
    return "png";
  }
  return "jpg";
};

export interface PageImageBlob {
  blob: Blob;
  pageNumber: number;
}

/**
 * Store rendered page images as BinaryFiles and append them to the scene as a
 * vertical column of image elements below `insertAt`, each tagged with
 * `customData.sourcePdf` pointing back at the source document.
 */
export const insertPageImages = async (
  blobs: PageImageBlob[],
  insertAt: { x: number; y: number },
  excalidrawAPI: ExcalidrawImperativeAPI,
  sourceFileId: FileId,
): Promise<ExcalidrawImageElement[]> => {
  const elements: ExcalidrawImageElement[] = [];
  const fileData: BinaryFileData[] = [];
  let cursorY = insertAt.y;

  for (const { blob, pageNumber } of blobs) {
    const mimeType = blob.type || "image/jpeg";
    const extension = extensionFor(mimeType);
    const fileId = await generateIdFromFile(
      new File([blob], `pdf-page-${pageNumber}.${extension}`, {
        type: mimeType,
      }),
    );
    const dataURL = await blobToDataURL(blob);
    const dimensions = await getImageBlobDimensions(blob);
    const height = (PAGE_IMAGE_WIDTH / dimensions.width) * dimensions.height;

    elements.push(
      newImageElement({
        type: "image",
        x: insertAt.x,
        y: cursorY,
        width: PAGE_IMAGE_WIDTH,
        height,
        fileId,
        status: "saved",
        customData: {
          sourcePdf: { fileId: sourceFileId, page: pageNumber },
        },
      }),
    );
    fileData.push({
      mimeType: mimeType as BinaryFileData["mimeType"],
      id: fileId,
      dataURL,
      created: Date.now(),
      lastRetrieved: Date.now(),
    });
    cursorY += height + PAGE_IMAGE_GAP;
  }

  excalidrawAPI.addFiles(fileData);
  excalidrawAPI.updateScene({
    elements: [...excalidrawAPI.getSceneElements(), ...elements],
    appState: {
      selectedElementIds: Object.fromEntries(
        elements.map((element) => [element.id, true]),
      ),
    },
  });
  return elements;
};
