/**
 * Embedded ↔ linked conversion for the "linked file assets" feature.
 *
 * convertToLinked: writes the original image bytes into the bound folder,
 * swaps the BinaryFileData dataURL for a generated thumbnail and records
 * `customData.linkedFile` (+ the bound frame's manifest).
 *
 * convertToEmbedded: reads the original back from disk, restores it into
 * BinaryFiles and removes `customData.linkedFile` (+ manifest entries).
 */

import { MIME_TYPES } from "@excalidraw/common";

import {
  CaptureUpdateAction,
  isFrameElement,
  isImageElement,
  newElementWith,
} from "@excalidraw/element";

import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
  ExcalidrawImageElement,
  NonDeleted,
} from "@excalidraw/element/types";

import type {
  BinaryFileData,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import {
  readFileByRelPath,
  resolveAvailableRelPath,
  sanitizeFileName,
  writeFileByRelPath,
} from "./fsAccess";
import {
  ensureFolderPermission,
  getFolderEntry,
  listFolderEntries,
  touchFolder,
} from "./folderRegistry";
import { enforceThumbnailBudget, generateThumbnail } from "./thumbnail";

import type {
  FolderRegistryEntry,
  LinkedFileMeta,
  SyncFolderMeta,
} from "./types";

// same mapping as packages/excalidraw/actions/actionDownloadOriginalImage.ts
const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  [MIME_TYPES.png]: "png",
  [MIME_TYPES.jpg]: "jpg",
  [MIME_TYPES.svg]: "svg",
  [MIME_TYPES.gif]: "gif",
  [MIME_TYPES.webp]: "webp",
  [MIME_TYPES.bmp]: "bmp",
  [MIME_TYPES.ico]: "ico",
  [MIME_TYPES.avif]: "avif",
  [MIME_TYPES.jfif]: "jfif",
};

const dataURLToBlob = async (dataURL: DataURL): Promise<Blob> => {
  return (await fetch(dataURL)).blob();
};

export const blobToDataURL = (blob: Blob): Promise<DataURL> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as DataURL);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const getSyncFolderMeta = (
  element: ExcalidrawElement | undefined,
): SyncFolderMeta | null => {
  if (element && isFrameElement(element)) {
    return (
      (element.customData?.syncFolder as SyncFolderMeta | undefined) ?? null
    );
  }
  return null;
};

interface TargetFolder {
  folderId: string;
  entry: FolderRegistryEntry;
  /** the sync frame bound to this folder, when one is on the scene */
  frame: ExcalidrawFrameElement | null;
}

/** the sync frame the element is inside, if any */
const resolveFrameFolder = async (
  sceneElements: readonly ExcalidrawElement[],
  element: ExcalidrawImageElement,
): Promise<TargetFolder | null> => {
  if (!element.frameId) {
    return null;
  }
  const frame = sceneElements.find((el) => el.id === element.frameId);
  const syncFolder = getSyncFolderMeta(frame);
  if (!frame || !syncFolder) {
    return null;
  }
  const entry = await getFolderEntry(syncFolder.folderId);
  if (!entry) {
    return null;
  }
  return {
    folderId: syncFolder.folderId,
    entry,
    frame: frame as ExcalidrawFrameElement,
  };
};

/** most recently used registered folder (+ its sync frame, if on the scene) */
const resolveMostRecentFolder = async (
  sceneElements: readonly ExcalidrawElement[],
): Promise<TargetFolder | null> => {
  const folderEntries = await listFolderEntries();
  if (!folderEntries.length) {
    return null;
  }
  folderEntries.sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt);
  const [folderId, entry] = folderEntries[0];
  const frame =
    (sceneElements.find(
      (el) =>
        isFrameElement(el) &&
        !el.isDeleted &&
        el.customData?.syncFolder?.folderId === folderId,
    ) as ExcalidrawFrameElement | undefined) ?? null;
  return { folderId, entry, frame };
};

/**
 * Converts embedded image elements to linked files in the bound folder.
 * Failures of individual elements surface as toasts and don't abort the rest.
 */
export const convertElementsToLinked = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
  elements: readonly ExcalidrawImageElement[],
): Promise<void> => {
  const sceneElements = excalidrawAPI.getSceneElementsIncludingDeleted();
  const files = excalidrawAPI.getFiles();

  // re-resolve by id — callers (bridge callback, context menu) may hold
  // stale element instances
  const candidates = elements
    .map((el) => sceneElements.find((s) => s.id === el.id) ?? el)
    .filter(
      (el): el is NonDeleted<ExcalidrawImageElement> =>
        isImageElement(el) &&
        !el.isDeleted &&
        !!el.fileId &&
        !el.customData?.linkedFile &&
        !!files[el.fileId]?.dataURL,
    );

  if (!candidates.length) {
    return;
  }

  let mostRecentFolder: TargetFolder | null | undefined;

  for (const element of candidates) {
    try {
      // resolve the target folder from fresh scene state on every iteration
      const freshSceneElements =
        excalidrawAPI.getSceneElementsIncludingDeleted();
      const freshElement =
        (freshSceneElements.find((el) => el.id === element.id) as
          | NonDeleted<ExcalidrawImageElement>
          | undefined) ?? element;
      if (freshElement.customData?.linkedFile) {
        // converted in the meantime (e.g. duplicate queue entries)
        continue;
      }

      const target =
        (await resolveFrameFolder(freshSceneElements, freshElement)) ??
        (mostRecentFolder !== undefined
          ? mostRecentFolder
          : (mostRecentFolder = await resolveMostRecentFolder(
              freshSceneElements,
            )));

      if (!target) {
        excalidrawAPI.setToast({
          message: "Create a sync frame first to link images to a folder",
        });
        return;
      }

      // NOTE conversions triggered from the context menu run in a user
      // gesture; sync-engine conversions rely on a previously granted state
      if (!(await ensureFolderPermission(target.entry.handle))) {
        excalidrawAPI.setToast({
          message: `Folder "${target.entry.rootName}" needs permission to link files`,
        });
        continue;
      }

      const fileData = excalidrawAPI.getFiles()[freshElement.fileId!];
      if (!fileData?.dataURL) {
        continue;
      }

      const blob = await dataURLToBlob(fileData.dataURL);
      const extension =
        EXTENSION_BY_MIME_TYPE[fileData.mimeType] ||
        fileData.mimeType.split("/")[1] ||
        "png";
      const relPath = await resolveAvailableRelPath(
        target.entry.handle,
        sanitizeFileName(`image-${freshElement.id}.${extension}`),
        new Set(
          Object.keys(
            getSyncFolderMeta(target.frame ?? undefined)?.manifest ?? {},
          ),
        ),
      );

      await writeFileByRelPath(target.entry.handle, relPath, blob);

      const thumbnail = await generateThumbnail(fileData.dataURL);

      // swap the original bytes for the thumbnail (version bump so the
      // persistence layer re-saves the file)
      excalidrawAPI.addFiles(
        [
          {
            ...fileData,
            mimeType: MIME_TYPES.webp,
            dataURL: thumbnail.dataURL,
            version: (fileData.version ?? 1) + 1,
            lastRetrieved: Date.now(),
          },
        ],
        { replace: true },
      );

      const linkedFile: LinkedFileMeta = {
        folderId: target.folderId,
        relPath,
        fileSize: blob.size,
        mimeType: fileData.mimeType,
        displayName: relPath.split("/").pop() ?? relPath,
        status: "ok",
        width: thumbnail.originalWidth,
        height: thumbnail.originalHeight,
      };

      excalidrawAPI.updateScene({
        elements: excalidrawAPI.getSceneElementsIncludingDeleted().map((el) => {
          if (el.id === freshElement.id) {
            return newElementWith(el, {
              customData: { ...el.customData, linkedFile },
            });
          }
          if (target.frame && el.id === target.frame.id) {
            const syncFolder = getSyncFolderMeta(el)!;
            const manifestEntry = syncFolder.manifest[relPath];
            return newElementWith(el, {
              customData: {
                ...el.customData,
                syncFolder: {
                  ...syncFolder,
                  manifest: {
                    ...syncFolder.manifest,
                    [relPath]: {
                      size: blob.size,
                      elementIds: [
                        ...(manifestEntry?.elementIds ?? []),
                        freshElement.id,
                      ],
                    },
                  },
                },
              },
            });
          }
          return el;
        }),
        captureUpdate: CaptureUpdateAction.EVENTUALLY,
      });

      await touchFolder(target.folderId);
    } catch (error: any) {
      console.error(error);
      excalidrawAPI.setToast({
        message: `Failed to link image: ${error?.message ?? error}`,
      });
    }
  }

  enforceThumbnailBudget(excalidrawAPI.getSceneElements());
};

/**
 * Converts linked image elements back to embedded images by reading the
 * original files from disk. Disk read failures surface as toasts and skip
 * the affected element.
 */
export const convertElementsToEmbedded = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
  elements: readonly ExcalidrawImageElement[],
): Promise<void> => {
  const sceneElements = excalidrawAPI.getSceneElementsIncludingDeleted();
  const candidates = elements
    .map((el) => sceneElements.find((s) => s.id === el.id) ?? el)
    .filter(
      (el): el is NonDeleted<ExcalidrawImageElement> =>
        isImageElement(el) &&
        !el.isDeleted &&
        !!el.fileId &&
        !!el.customData?.linkedFile,
    );

  if (!candidates.length) {
    return;
  }

  for (const element of candidates) {
    const linkedFile = element.customData!.linkedFile as LinkedFileMeta;
    try {
      const entry = await getFolderEntry(linkedFile.folderId);
      if (!entry) {
        throw new Error("Linked folder is no longer registered");
      }
      if (!(await ensureFolderPermission(entry.handle))) {
        excalidrawAPI.setToast({
          message: `Folder "${entry.rootName}" needs permission to embed files`,
        });
        continue;
      }

      const file = await readFileByRelPath(entry.handle, linkedFile.relPath);
      const dataURL = await blobToDataURL(file);

      const existing = excalidrawAPI.getFiles()[element.fileId!];
      const fileData: BinaryFileData = {
        id: element.fileId!,
        mimeType:
          (file.type as BinaryFileData["mimeType"]) ||
          existing?.mimeType ||
          MIME_TYPES.png,
        dataURL,
        created: existing?.created ?? Date.now(),
        lastRetrieved: Date.now(),
        version: (existing?.version ?? 1) + 1,
      };
      excalidrawAPI.addFiles([fileData], { replace: true });

      const freshElement =
        excalidrawAPI
          .getSceneElementsIncludingDeleted()
          .find((el) => el.id === element.id) ?? element;

      excalidrawAPI.updateScene({
        elements: excalidrawAPI.getSceneElementsIncludingDeleted().map((el) => {
          if (el.id === freshElement.id) {
            const { linkedFile: _removed, ...customData } = el.customData ?? {};
            return newElementWith(el, { customData });
          }
          if (freshElement.frameId && el.id === freshElement.frameId) {
            const syncFolder = getSyncFolderMeta(el);
            const manifestEntry = syncFolder?.manifest[linkedFile.relPath];
            if (syncFolder && manifestEntry) {
              const elementIds = manifestEntry.elementIds.filter(
                (id) => id !== freshElement.id,
              );
              const manifest = { ...syncFolder.manifest };
              if (elementIds.length) {
                manifest[linkedFile.relPath] = {
                  ...manifestEntry,
                  elementIds,
                };
              } else {
                // drop empty manifest entries
                delete manifest[linkedFile.relPath];
              }
              return newElementWith(el, {
                customData: {
                  ...el.customData,
                  syncFolder: { ...syncFolder, manifest },
                },
              });
            }
          }
          return el;
        }),
        captureUpdate: CaptureUpdateAction.EVENTUALLY,
      });

      await touchFolder(linkedFile.folderId);
    } catch (error: any) {
      console.error(error);
      excalidrawAPI.setToast({
        message: `Failed to embed linked file: ${error?.message ?? error}`,
      });
    }
  }
};
