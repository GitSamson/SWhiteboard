/**
 * Page-turn logic for `pdf` elements: replaces the element with a
 * `newElementWith` clone whose `customData.sourceFile.currentPage` is
 * updated, without capturing an undo step (the visible page is a view state,
 * not a document edit — same policy as the linked-assets background verify).
 */

import { CaptureUpdateAction, newElementWith } from "@excalidraw/element";

import type { ExcalidrawPdfElement } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { ensurePdfPage } from "./pdfPageCache";

import type { PdfSourceFileMeta } from "./pdfImport";

export const turnPdfPage = (
  excalidrawAPI: ExcalidrawImperativeAPI,
  element: ExcalidrawPdfElement,
  nextPage: number,
): void => {
  const sourceFile = element.customData?.sourceFile as
    | PdfSourceFileMeta
    | undefined;
  if (!sourceFile) {
    return;
  }
  const currentPage = sourceFile.currentPage ?? 1;
  const clamped = Math.min(
    Math.max(1, Math.round(nextPage)),
    Math.max(1, sourceFile.pageCount ?? 1),
  );
  if (clamped === currentPage) {
    return;
  }

  const updated = newElementWith(element, {
    customData: {
      ...element.customData,
      sourceFile: { ...sourceFile, currentPage: clamped },
    },
  });

  excalidrawAPI.updateScene({
    elements: excalidrawAPI
      .getSceneElements()
      .map((el) => (el.id === element.id ? updated : el)),
    captureUpdate: CaptureUpdateAction.NEVER,
  });

  void ensurePdfPage(excalidrawAPI, updated, clamped);
  // prefetch the likely-next pages so a following flip renders instantly
  // (no-op when cached — server disk cache absorbs the first-ever render)
  if (clamped + 1 <= (sourceFile.pageCount ?? 1)) {
    void ensurePdfPage(excalidrawAPI, updated, clamped + 1);
  }
  if (clamped - 1 >= 1) {
    void ensurePdfPage(excalidrawAPI, updated, clamped - 1);
  }
};
