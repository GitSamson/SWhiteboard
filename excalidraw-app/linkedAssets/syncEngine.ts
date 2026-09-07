/**
 * Sync engine for the "linked file assets" feature: watches scene changes
 * via `excalidrawAPI.onChange` and enqueues conversions to linked files when
 * an image element's `frameId` newly points at a sync frame.
 *
 * All disk writes go through a serial queue so they never interleave;
 * failures surface as toasts and don't break the queue.
 */

import { debounce } from "@excalidraw/common";

import { isFrameElement, isImageElement } from "@excalidraw/element";

import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
} from "@excalidraw/element/types";

import type {
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { appJotaiStore } from "../app-jotai";

import { convertElementsToLinked } from "./convert";
import {
  duplicateLinkedFiles,
  findUnregisteredLinkedDuplicates,
} from "./duplicate";
import { unlinkFolderLinks } from "./frameActions";
import { isLinkedAssetsAvailable, orphanedSyncFolderAtom } from "./state";

import type { LinkedFileMeta, SyncFolderMeta } from "./types";

const SYNC_DEBOUNCE_MS = 300;

interface LedgerEntry {
  /** frameId when it points at a sync frame, else null */
  frameId: string | null;
  linked: boolean;
}

let writeQueue: Promise<void> = Promise.resolve();

/** serial queue for all conversions/writes; errors toast and the queue continues */
export const enqueueConversion = (
  excalidrawAPI: ExcalidrawImperativeAPI,
  task: () => Promise<void>,
): void => {
  writeQueue = writeQueue.then(task).catch((error: any) => {
    console.error(error);
    excalidrawAPI.setToast({
      message: `Linked assets sync failed: ${error?.message ?? error}`,
    });
  });
};

/** enqueues a conversion of the given (embedded) images to linked files */
export const enqueueConvertToLinked = (
  excalidrawAPI: ExcalidrawImperativeAPI,
  elements: readonly ExcalidrawImageElement[],
): void => {
  if (!elements.length || !isLinkedAssetsAvailable()) {
    return;
  }
  enqueueConversion(excalidrawAPI, () =>
    convertElementsToLinked(excalidrawAPI, elements),
  );
};

/**
 * Subscribes to scene changes and converts image elements that were newly
 * moved into a sync frame (e.g. by dragging) into linked files. Also gives
 * duplicated linked images their own on-disk copy, and unlinks a folder's
 * images when its sync frame is deleted (files on disk stay untouched).
 * Board deletion of a linked image only hides it (native isDeleted); real
 * disk deletion happens via the frame's "delete hidden images" menu entry.
 * Returns an unsubscribe/cleanup function.
 */
export const startSyncEngine = (
  excalidrawAPI: ExcalidrawImperativeAPI,
): (() => void) => {
  const ledger = new Map<string, LedgerEntry>();
  // sync frame id → alive; used to detect frame deletions
  const frameLedger = new Map<string, boolean>();
  // ids with an in-flight duplication; element id → relPath of the last
  // failed/successful attempt, to avoid re-enqueueing on every scene change
  const pendingDuplication = new Set<string>();
  const attemptedDuplication = new Map<string, string>();
  // the first callback primes the ledger without triggering conversions —
  // only *transitions* into a sync frame should convert
  let primed = false;
  let stopped = false;

  const handleChange = debounce(
    (
      elements: readonly ExcalidrawElement[],
      _appState: unknown,
      files: BinaryFiles,
    ) => {
      if (stopped || !isLinkedAssetsAvailable()) {
        return;
      }
      // no point writing to disk while the tab is hidden
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }

      const syncFrameIds = new Set(
        elements
          .filter(
            (el) =>
              isFrameElement(el) && !el.isDeleted && el.customData?.syncFolder,
          )
          .map((el) => el.id),
      );

      const seenIds = new Set<string>();
      const toConvert: ExcalidrawImageElement[] = [];
      const wasPrimed = primed;

      // sync frame deletions: ask the user whether the folder's files
      // should be deleted too, then unlink the images either way (the
      // dialog performs the unlink). Frames without files are unlinked
      // directly. Skipped on the priming pass.
      const seenFrameIds = new Set<string>();
      for (const element of elements) {
        if (!isFrameElement(element)) {
          continue;
        }
        const syncFolder = element.customData?.syncFolder as
          | SyncFolderMeta
          | undefined;
        if (!syncFolder) {
          continue;
        }
        seenFrameIds.add(element.id);
        if (
          wasPrimed &&
          frameLedger.get(element.id) === true &&
          element.isDeleted
        ) {
          enqueueConversion(excalidrawAPI, async () => {
            const relPaths = Object.keys(syncFolder.manifest);
            if (relPaths.length) {
              appJotaiStore.set(orphanedSyncFolderAtom, {
                folderId: syncFolder.folderId,
                rootName: syncFolder.rootName,
                relPaths,
              });
            } else {
              unlinkFolderLinks(excalidrawAPI, syncFolder.folderId);
            }
          });
        }
        frameLedger.set(element.id, !element.isDeleted);
      }
      for (const id of [...frameLedger.keys()]) {
        if (!seenFrameIds.has(id)) {
          frameLedger.delete(id);
        }
      }

      for (const element of elements) {
        if (!isImageElement(element)) {
          continue;
        }
        if (element.isDeleted) {
          ledger.delete(element.id);
          attemptedDuplication.delete(element.id);
          continue;
        }
        seenIds.add(element.id);

        const frameId =
          element.frameId && syncFrameIds.has(element.frameId)
            ? element.frameId
            : null;
        const linkedMeta = element.customData?.linkedFile as
          | LinkedFileMeta
          | undefined;
        const linked = !!linkedMeta;
        const prev = ledger.get(element.id);

        if (
          primed &&
          frameId &&
          !linked &&
          !!element.fileId &&
          !!files[element.fileId]?.dataURL &&
          (!prev || prev.frameId !== frameId)
        ) {
          toConvert.push(element);
        }

        ledger.set(element.id, { frameId, linked });
      }

      // drop ledger entries of elements removed from the scene
      for (const id of [...ledger.keys()]) {
        if (!seenIds.has(id)) {
          ledger.delete(id);
        }
      }

      primed = true;

      if (toConvert.length) {
        enqueueConvertToLinked(excalidrawAPI, toConvert);
      }

      // clones of a linked element (copy/paste, duplicate, alt-drag) share
      // its relPath; give each clone its own on-disk copy. Skipped on the
      // priming pass — loading a scene must not write to disk.
      if (wasPrimed) {
        const toDuplicate = findUnregisteredLinkedDuplicates(elements).filter(
          (element) => {
            if (pendingDuplication.has(element.id)) {
              return false;
            }
            const relPath = (
              element.customData?.linkedFile as { relPath?: string } | undefined
            )?.relPath;
            // skip ids whose last attempt for this relPath already ran;
            // a relPath change (e.g. rename) re-arms the element
            return attemptedDuplication.get(element.id) !== relPath;
          },
        );
        if (toDuplicate.length) {
          for (const element of toDuplicate) {
            pendingDuplication.add(element.id);
            attemptedDuplication.set(
              element.id,
              (element.customData?.linkedFile as { relPath: string }).relPath,
            );
          }
          enqueueConversion(excalidrawAPI, async () => {
            try {
              await duplicateLinkedFiles(excalidrawAPI, toDuplicate);
            } finally {
              for (const element of toDuplicate) {
                pendingDuplication.delete(element.id);
              }
            }
          });
        }
      }
    },
    SYNC_DEBOUNCE_MS,
  );

  const unsubscribe = excalidrawAPI.onChange(handleChange);

  return () => {
    stopped = true;
    unsubscribe();
  };
};
