/**
 * Thumbnail generation for the "linked file assets" feature: linked images
 * keep only a downscaled webp thumbnail in the scene BinaryFiles (persisted
 * to IDB), while the original bytes live in the bound folder on disk.
 *
 * Canvas access is factored into `renderToWebpDataURL` so tests running in
 * jsdom (no canvas 2d implementation) can mock it.
 */

import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { DataURL } from "@excalidraw/excalidraw/types";

/** longest edge of generated thumbnails, in px */
export const LINKED_THUMBNAIL_MAX_SIDE = 512;

/** soft cap of linked thumbnails kept in BinaryFiles; LRU eviction past it */
export const LINKED_THUMBNAIL_LIMIT = 3000;

const THUMBNAIL_MIME_TYPE = "image/webp";
const THUMBNAIL_QUALITY = 0.7;

const loadImage = (
  dataURL: DataURL,
  doc: Document,
): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = doc.createElement("img");
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode image dataURL"));
    image.src = dataURL;
  });

/** scales to fit within LINKED_THUMBNAIL_MAX_SIDE, never upscales */
export const getThumbnailDimensions = (
  width: number,
  height: number,
): { width: number; height: number } => {
  const longest = Math.max(width, height);
  if (longest <= LINKED_THUMBNAIL_MAX_SIDE || longest <= 0) {
    return { width, height };
  }
  const scale = LINKED_THUMBNAIL_MAX_SIDE / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

/**
 * Renders `image` into a canvas at the given size and returns a webp
 * dataURL. Isolated so tests can mock it (jsdom has no canvas 2d context).
 */
export const renderToWebpDataURL = (
  image: HTMLImageElement,
  width: number,
  height: number,
  doc: Document,
): DataURL => {
  const canvas = doc.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D context is not available");
  }
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL(THUMBNAIL_MIME_TYPE, THUMBNAIL_QUALITY) as DataURL;
};

/** decodes `dataURL` and returns a downscaled webp thumbnail + its size */
export const generateThumbnail = async (
  dataURL: DataURL,
  opts: { doc?: Document } = {},
): Promise<{ dataURL: DataURL; width: number; height: number }> => {
  const doc = opts.doc ?? document;
  const image = await loadImage(dataURL, doc);
  const { width, height } = getThumbnailDimensions(
    image.naturalWidth,
    image.naturalHeight,
  );
  return {
    dataURL: renderToWebpDataURL(image, width, height, doc),
    width,
    height,
  };
};

/** counts linked thumbnails currently stored in the scene */
export const countLinkedThumbnails = (
  elements: readonly ExcalidrawElement[],
): number =>
  elements.filter(
    (element) => !element.isDeleted && !!element.customData?.linkedFile,
  ).length;

/**
 * Budget guard the sync engine calls after conversions.
 *
 * TODO(M5): when over LINKED_THUMBNAIL_LIMIT, evict the oldest linked
 * thumbnails (by element `updated`) — affected elements re-generate their
 * thumbnail from disk on next render.
 */
export const enforceThumbnailBudget = (
  elements: readonly ExcalidrawElement[],
): { count: number; overBudget: boolean } => {
  const count = countLinkedThumbnails(elements);
  return { count, overBudget: count > LINKED_THUMBNAIL_LIMIT };
};
