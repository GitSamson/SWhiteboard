/**
 * Import a dropped/opened PDF file as a native `pdf` element.
 *
 * The PDF binary lives in the scene BinaryFiles (so it travels inside the
 * .excalidraw file); the element itself carries only
 * `customData.sourceFile = { fileId, kind: "pdf", name, pageCount, currentPage }`.
 * Page bitmaps are rasterized on the dev server and rendered by the library's
 * static canvas pipeline (see pdfPageCache.ts).
 */

import {
  CaptureUpdateAction,
  newElementWith,
  newPdfElement,
} from "@excalidraw/element";
import { generateIdFromFile } from "@excalidraw/excalidraw/data/blob";
import { t } from "@excalidraw/excalidraw/i18n";

import type { FileId } from "@excalidraw/element/types";
import type {
  BinaryFileData,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { blobToDataURL } from "../linkedAssets/convert";

import { ensurePdfPage, openPdfData } from "./pdfPageCache";

export interface PdfSourceFileMeta {
  fileId: FileId;
  kind: "pdf";
  name: string;
  pageCount: number;
  currentPage: number;
}

export const PDF_ELEMENT_WIDTH = 480;
/** fallback height when the server-side open fails (A4-ish ratio) */
export const PDF_ELEMENT_FALLBACK_HEIGHT = 640;

export const importPdfFile = async (
  file: File,
  pos: { x: number; y: number },
  excalidrawAPI: ExcalidrawImperativeAPI,
): Promise<void> => {
  let dataURL: DataURL;
  let fileId: FileId;
  try {
    [dataURL, fileId] = await Promise.all([
      blobToDataURL(file),
      generateIdFromFile(file),
    ]);
  } catch (error) {
    excalidrawAPI.setToast({ message: t("mediaImport.loadError") });
    return;
  }

  excalidrawAPI.addFiles([
    {
      // "application/pdf" is not in BinaryFileData["mimeType"] on the
      // library side (landed in parallel) — cast locally until then
      mimeType: "application/pdf" as BinaryFileData["mimeType"],
      id: fileId,
      dataURL,
      created: Date.now(),
      lastRetrieved: Date.now(),
    },
  ]);

  // stagger repeated imports so a second PDF doesn't land exactly on top of
  // the first one at the viewport center (looked like "import did nothing")
  const existingMedia = excalidrawAPI
    .getSceneElements()
    .filter((el) => el.customData?.sourceFile).length;
  const offset = (existingMedia % 6) * 48;

  // show the (loading) box immediately at the placeholder size — the gray
  // box + spinner render right away, the real page count/size arrive below
  const element = newPdfElement({
    type: "pdf",
    x: pos.x + offset,
    y: pos.y + offset,
    width: PDF_ELEMENT_WIDTH,
    height: PDF_ELEMENT_FALLBACK_HEIGHT,
    customData: {
      sourceFile: {
        fileId,
        kind: "pdf",
        name: file.name,
        pageCount: 1,
        currentPage: 1,
      },
    },
  });

  excalidrawAPI.updateScene({
    elements: [...excalidrawAPI.getSceneElements(), element],
    appState: { selectedElementIds: { [element.id]: true } },
  });

  // first render shows the placeholder until the page bitmap arrives
  void ensurePdfPage(excalidrawAPI, element, 1);

  // size the element to the first page's aspect ratio, fitted inside the
  // placeholder box (one dimension matches the box, ratio = page ratio).
  // Without the dev endpoint (production hosting) the box stays as-is and
  // the file remains importable.
  try {
    const info = await openPdfData(dataURL);
    const firstPage = info.pages[0];
    let width = PDF_ELEMENT_WIDTH;
    let height = PDF_ELEMENT_FALLBACK_HEIGHT;
    if (firstPage && firstPage.width > 0) {
      const pageRatio = firstPage.height / firstPage.width;
      if (pageRatio >= 1) {
        height = PDF_ELEMENT_FALLBACK_HEIGHT;
        width = Math.round(height / pageRatio);
      } else {
        width = PDF_ELEMENT_WIDTH;
        height = Math.round(width * pageRatio);
      }
    }
    const latest = excalidrawAPI
      .getSceneElements()
      .find((el) => el.id === element.id);
    if (latest && (latest.width !== width || latest.height !== height)) {
      excalidrawAPI.updateScene({
        elements: excalidrawAPI.getSceneElements().map((el) =>
          el.id === element.id
            ? newElementWith(el, {
                width,
                height,
                customData: {
                  ...el.customData,
                  sourceFile: {
                    ...(el.customData?.sourceFile as object),
                    pageCount: info.pageCount,
                  },
                },
              })
            : el,
        ),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
    // prefetch page 2 so the first flip is instant
    if (info.pageCount >= 2) {
      void ensurePdfPage(excalidrawAPI, element, 2);
    }
  } catch (error) {
    console.warn("[pdf] pdf-open failed, keeping fallback size", error);
    excalidrawAPI.setToast({ message: t("mediaImport.loadError") });
  }
};
