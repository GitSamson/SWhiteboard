/**
 * Thumbnail-first rendering for the image cache.
 *
 * The resolver below is injected into @excalidraw/element's image cache via
 * setThumbnailResolver(): instead of decoding every image at full
 * resolution, the cache decodes a small webp thumbnail and records the
 * `sourceScale` so renderers can map crop coordinates onto it.
 *
 * - linked images: the scene BinaryFiles entry already IS a 512px webp
 *   thumbnail — return it directly with the original dimensions recorded in
 *   the element's linkedFile meta (no disk read on the render path).
 * - embedded images: consult the persistent tier store; on a miss let the
 *   caller decode the original and enqueue background tier generation so
 *   the next fill (this session or a later one) is cheap.
 *
 * Images displayed larger than their cached tier are upgraded back to the
 * original by the library's quality-sync scheduler (forceOriginal), which
 * bypasses this resolver.
 */

import { MIME_TYPES } from "@excalidraw/common";

import type { ThumbnailResolver } from "@excalidraw/excalidraw";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { findLinkedMetaByFileId } from "./originals";
import {
  enqueueThumbnailGeneration,
  resolveStoredThumbnail,
} from "./thumbnailStore";

/** default on-screen size assumption when the caller passes no hint */
const DEFAULT_NEEDED_PX = 512;

export const createThumbnailResolver = (
  excalidrawAPI: ExcalidrawImperativeAPI,
): ThumbnailResolver => {
  return async (fileId, fileData, { maxDisplayPx }) => {
    // vector and animated images must render from their original bytes
    if (
      fileData.mimeType === MIME_TYPES.svg ||
      fileData.mimeType === "image/gif"
    ) {
      return null;
    }

    const meta = findLinkedMetaByFileId(excalidrawAPI, fileId);
    if (meta) {
      if (meta.width && meta.height) {
        return {
          dataURL: fileData.dataURL,
          originalWidth: meta.width,
          originalHeight: meta.height,
        };
      }
      // legacy linked image without recorded dimensions — keep the previous
      // behavior (fall through to the full-resolution linked original)
      return null;
    }

    const stored = await resolveStoredThumbnail(
      fileId,
      maxDisplayPx ?? DEFAULT_NEEDED_PX,
    );
    if (stored) {
      return stored;
    }
    // miss: decode the original this time; generate tiers in the background
    enqueueThumbnailGeneration(fileId, fileData.dataURL);
    return null;
  };
};
