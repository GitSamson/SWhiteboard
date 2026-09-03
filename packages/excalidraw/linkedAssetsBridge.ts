import type {
  ExcalidrawFrameElement,
  ExcalidrawImageElement,
  FileId,
} from "@excalidraw/element/types";

import type { BinaryFileData, BinaryFiles, DataURL } from "./types";

/**
 * Bridge between the library (packages/excalidraw) and the app-layer
 * "linked file assets" feature (excalidraw-app/linkedAssets).
 *
 * The library itself ships no linked-assets behavior; the app injects an
 * implementation at startup via `setLinkedAssetsBridge()`. When no bridge
 * is registered (library used standalone, feature flag off, unsupported
 * browser), every consumer must treat `getLinkedAssetsBridge() === null`
 * as "feature disabled" and behave as before.
 */

export type LinkedImageInsertSource = "paste" | "drop" | "toolbar";

export interface LinkedAssetsBridge {
  /** called after images were inserted into the scene */
  onImagesInserted: (
    source: LinkedImageInsertSource,
    files: BinaryFiles,
    elements: readonly ExcalidrawImageElement[],
  ) => void;
  /**
   * resolves the original (full-resolution) dataURL for a linked image,
   * or `null` when unavailable (caller falls back to the embedded dataURL)
   */
  resolveOriginal: (
    fileId: FileId,
    fileData: BinaryFileData,
  ) => Promise<DataURL | null>;
  /**
   * returns a copy of `files` with linked thumbnails replaced by their
   * originals (in-memory only, for PNG/SVG export)
   */
  resolveOriginalsForExport: (files: BinaryFiles) => Promise<BinaryFiles>;
  /** opens the rename flow for a linked image */
  renameImage: (element: ExcalidrawImageElement) => void;
  /** converts embedded images to linked files in the bound folder */
  convertToLinked: (
    elements: readonly ExcalidrawImageElement[],
  ) => Promise<void>;
  /** converts linked images back to embedded images */
  convertToEmbedded: (
    elements: readonly ExcalidrawImageElement[],
  ) => Promise<void>;
  /** un-deletes hidden linked images in a sync frame */
  showHiddenImages: (frame: ExcalidrawFrameElement) => void;
  /** deletes the on-disk files of hidden linked images in a sync frame */
  deleteHiddenImages: (frame: ExcalidrawFrameElement) => Promise<void>;
  /** unhides and re-lays out a sync frame's linked images in a grid */
  resetSyncFrameLayout: (frame: ExcalidrawFrameElement) => void;
}

let linkedAssetsBridge: LinkedAssetsBridge | null = null;

export const setLinkedAssetsBridge = (
  handler: LinkedAssetsBridge | null,
): void => {
  linkedAssetsBridge = handler;
};

export const getLinkedAssetsBridge = (): LinkedAssetsBridge | null =>
  linkedAssetsBridge;
