/**
 * Asset-type registry for the "linked file assets" feature — the extension
 * point for supporting file types beyond images in sync folders and linked
 * files.
 *
 * Design rules:
 * - The registry lives in the app layer; the library's own MIME whitelist
 *   (`IMAGE_MIME_TYPES` in @excalidraw/common) is untouched and only covers
 *   embeddable image insertion. App-layer file filters (folder scans,
 *   imports) MUST go through `isImportableAssetFile()` here instead of
 *   hardcoding extension lists.
 * - Handlers with `implemented: false` are declared placeholders (video,
 *   pdf): they document the intended shape but are excluded from import
 *   filters, so unimplemented types never reach the scene.
 *
 * To add real video/PDF support later: implement `generatePreview`
 * (video: grab a frame via <video>; pdf: render page 1 via pdfjs — a new
 * dependency), flip `implemented` to true, and extend the renderer with the
 * type's render hint (the Pixi compositor treats unknown types as static
 * previews).
 */

import { IMAGE_MIME_TYPES } from "@excalidraw/common";

export interface AssetTypeHandler {
  /** unique type id, e.g. "image" | "video" | "pdf" */
  id: string;
  /** file extensions (lowercase, no dot) this handler covers */
  extensions: readonly string[];
  /** whether the linked-assets pipeline supports this type today */
  implemented: boolean;
  /**
   * how the render cache should treat this type:
   * - "image": decodable by <img>; thumbnails + hi-res upgrade apply
   * - "static-preview": only the stored preview is ever rendered (planned
   *   for video/PDF: scene shows the preview; the original bytes are only
   *   touched on export/open)
   */
  renderHint: "image" | "static-preview";
}

const imageHandler: AssetTypeHandler = {
  id: "image",
  extensions: [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "svg",
    "bmp",
    "ico",
    "avif",
    "jfif",
  ],
  implemented: true,
  renderHint: "image",
};

const videoHandler: AssetTypeHandler = {
  id: "video",
  extensions: ["mp4", "webm", "mov"],
  implemented: false,
  renderHint: "static-preview",
};

const pdfHandler: AssetTypeHandler = {
  id: "pdf",
  extensions: ["pdf"],
  implemented: false,
  renderHint: "static-preview",
};

const handlers: readonly AssetTypeHandler[] = [
  imageHandler,
  videoHandler,
  pdfHandler,
];

/** all registered handlers, including unimplemented placeholders */
export const listAssetTypeHandlers = (): readonly AssetTypeHandler[] =>
  handlers;

/** handler for a file extension (lowercase, no dot), or null */
export const getAssetTypeHandler = (
  extension: string,
): AssetTypeHandler | null =>
  handlers.find((handler) => handler.extensions.includes(extension)) ?? null;

const IMAGE_MIME_TYPE_SET: ReadonlySet<string> = new Set(
  Object.values(IMAGE_MIME_TYPES),
);

/** whether the file may be imported into a sync frame / linked today */
export const isImportableAssetFile = (file: {
  name: string;
  mimeType?: string;
}): boolean => {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const handler = getAssetTypeHandler(extension);
  if (!handler?.implemented) {
    return false;
  }
  // when a mimeType is available it must agree (a renamed non-image file
  // with an image extension must not slip through)
  if (file.mimeType) {
    return IMAGE_MIME_TYPE_SET.has(file.mimeType);
  }
  return handler.id === "image";
};
