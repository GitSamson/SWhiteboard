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

/**
 * thumbnail tier sizes (longest edge, px) generated for the IDB thumbnail
 * store — the render cache picks the smallest tier that covers the
 * element's on-screen size and upgrades to the original past the top tier
 */
export const THUMBNAIL_TIERS = [256, 512, 1024] as const;

export type ThumbnailTier = typeof THUMBNAIL_TIERS[number];

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
): Promise<{
  dataURL: DataURL;
  width: number;
  height: number;
  /** full-resolution dimensions of the source image */
  originalWidth: number;
  originalHeight: number;
}> => {
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
    originalWidth: image.naturalWidth,
    originalHeight: image.naturalHeight,
  };
};

/**
 * Decodes `dataURL` once and renders every tier that is strictly smaller
 * than the original (never upscales). Returns the tier dataURLs plus the
 * original's dimensions; `tiers` is empty for small images.
 */
export const generateThumbnailTiers = async (
  dataURL: DataURL,
  opts: { doc?: Document } = {},
): Promise<{
  tiers: Partial<Record<ThumbnailTier, DataURL>>;
  originalWidth: number;
  originalHeight: number;
}> => {
  const doc = opts.doc ?? document;
  const image = await loadImage(dataURL, doc);
  const { naturalWidth, naturalHeight } = image;
  const longest = Math.max(naturalWidth, naturalHeight);

  const tiers: Partial<Record<ThumbnailTier, DataURL>> = {};
  for (const tier of THUMBNAIL_TIERS) {
    if (tier >= longest || longest <= 0) {
      continue;
    }
    const scale = tier / longest;
    tiers[tier] = renderToWebpDataURL(
      image,
      Math.max(1, Math.round(naturalWidth * scale)),
      Math.max(1, Math.round(naturalHeight * scale)),
      doc,
    );
  }
  return { tiers, originalWidth: naturalWidth, originalHeight: naturalHeight };
};

/**
 * Picks the smallest tier that covers `neededPx` (device px), or the
 * largest available tier when none is big enough (the renderer upgrades to
 * the original past that). Returns null when no tiers exist.
 */
export const pickThumbnailTier = (
  availableTiers: readonly number[],
  neededPx: number,
): number | null => {
  if (!availableTiers.length) {
    return null;
  }
  const sorted = [...availableTiers].sort((a, b) => a - b);
  for (const tier of sorted) {
    if (tier >= neededPx) {
      return tier;
    }
  }
  return sorted[sorted.length - 1];
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
