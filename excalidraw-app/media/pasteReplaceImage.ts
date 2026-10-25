/**
 * Paste-to-replace: when a single image element is selected and the user
 * pastes an image (file), the pasted image REPLACES the selected element's
 * content instead of inserting a new element. The element keeps its box
 * (position, size, angle, flip is reset); the new image is center-cropped
 * ("fill"/cover) so it covers the element's aspect ratio exactly, using the
 * native `crop` field — the user can still fine-tune the framing with the
 * crop editor afterwards.
 */

import {
  CaptureUpdateAction,
  isImageElement,
  isInitializedImageElement,
  newElementWith,
} from "@excalidraw/element";
import {
  generateIdFromFile,
  isSupportedImageFile,
} from "@excalidraw/excalidraw/data/blob";

import type { ImageCrop } from "@excalidraw/element/types";
import type {
  BinaryFileData,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { blobToDataURL } from "../linkedAssets/convert";

/**
 * Center-crop rectangle (in natural-image pixels) so the cropped region has
 * exactly `targetAspect` (width / height) — the classic "cover"/fill fit.
 */
export const centerFillCrop = (
  naturalWidth: number,
  naturalHeight: number,
  targetAspect: number,
): ImageCrop => {
  const naturalAspect = naturalWidth / naturalHeight;
  let width = naturalWidth;
  let height = naturalHeight;
  if (naturalAspect > targetAspect) {
    // source wider than target → cut left/right
    width = naturalHeight * targetAspect;
  } else {
    // source taller than target → cut top/bottom
    height = naturalWidth / targetAspect;
  }
  return {
    x: (naturalWidth - width) / 2,
    y: (naturalHeight - height) / 2,
    width,
    height,
    naturalWidth,
    naturalHeight,
  };
};

const readImageSize = async (
  file: File,
): Promise<{ width: number; height: number } | null> => {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    // e.g. SVGs without intrinsic size — replace without cropping
    return null;
  }
};

/**
 * Returns true when the paste was consumed (image replaced), false when the
 * default paste flow should proceed.
 */
export const maybeReplaceSelectedImage = async (
  files: readonly File[],
  excalidrawAPI: ExcalidrawImperativeAPI,
): Promise<boolean> => {
  if (files.length !== 1 || !isSupportedImageFile(files[0])) {
    return false;
  }
  const appState = excalidrawAPI.getAppState();
  // never swap the image underneath an active crop session
  if (appState.croppingElementId) {
    return false;
  }
  const selected = excalidrawAPI
    .getSceneElements()
    .filter((element) => appState.selectedElementIds[element.id]);
  if (selected.length !== 1 || !isInitializedImageElement(selected[0])) {
    return false;
  }
  const target = selected[0];
  const file = files[0];

  const dataURL = (await blobToDataURL(file)) as DataURL;
  const fileId = await generateIdFromFile(file);
  const now = Date.now();
  excalidrawAPI.addFiles([
    {
      id: fileId,
      mimeType: file.type as BinaryFileData["mimeType"],
      dataURL,
      created: now,
      lastRetrieved: now,
    },
  ]);

  const size = await readImageSize(file);
  const crop = size
    ? centerFillCrop(size.width, size.height, target.width / target.height)
    : null;

  excalidrawAPI.updateScene({
    elements: excalidrawAPI
      .getSceneElementsIncludingDeleted()
      .map((element) => {
        if (element.id !== target.id || !isImageElement(element)) {
          return element;
        }
        return newElementWith(element, {
          fileId,
          crop,
          // reset any flip so the pasted image isn't mirrored
          scale: [1, 1],
          status: "saved",
        });
      }),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  return true;
};
