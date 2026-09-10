/**
 * Data model for the "linked file assets" feature.
 *
 * Linked image elements carry `element.customData.linkedFile: LinkedFileMeta`;
 * sync frames carry `frame.customData.syncFolder: SyncFolderMeta`.
 * `customData` is preserved across restore/duplicate/serialize, so the
 * linkage survives saving/sharing the scene.
 */

/** `element.customData.linkedFile` on linked image elements */
export interface LinkedFileMeta {
  /** folder registry id (see folderRegistry.ts) */
  folderId: string;
  /** path relative to the bound folder root, e.g. "cats/1.png" */
  relPath: string;
  /** file size in bytes, used as a secondary identity/check attribute */
  fileSize: number;
  /** mimeType of the original file on disk (the scene stores a webp thumbnail) */
  mimeType: string;
  /** display name (== relPath basename) */
  displayName: string;
  status: "ok" | "missing";
  /**
   * full-resolution dimensions of the original image, recorded at
   * import/conversion time. The render cache needs them to map crop
   * coordinates onto the embedded thumbnail. Optional: scenes saved before
   * this field existed fall back to loading the original from disk.
   */
  width?: number;
  height?: number;
}

export interface SyncFolderManifestEntry {
  /** file size in bytes */
  size: number;
  /** ids of image elements linked to this file */
  elementIds: string[];
}

/** `frame.customData.syncFolder` on sync frames */
export interface SyncFolderMeta {
  /** folder registry id (see folderRegistry.ts) */
  folderId: string;
  /** directory name, for display purposes */
  rootName: string;
  /** relPath → entry; lives in the scene, the linked folder holds no metadata */
  manifest: Record<string, SyncFolderManifestEntry>;
}

/** app-level folder registry entry (IDB, not part of the scene) */
export interface FolderRegistryEntry {
  handle: FileSystemDirectoryHandle;
  rootName: string;
  lastUsedAt: number;
}
