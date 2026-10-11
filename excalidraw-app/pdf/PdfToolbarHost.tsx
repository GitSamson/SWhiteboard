/**
 * Toolbar host for the native `pdf` element type, rendered app-side as a
 * portal below the selected element's box (same positioning as the video
 * capture-frame button). Page turns go through `turnPdfPage` (NEVER captured
 * in undo history); "extract"/"expand" rasterize pages on the dev server and
 * insert them as regular image elements.
 */

import { useCallback, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "@excalidraw/excalidraw/i18n";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { fetchPdfPage, openPdfData } from "./pdfPageCache";
import { togglePdfHiRes, turnPdfPage } from "./pdfNavigation";
import { insertPageImages } from "./pdfPages";
import { clampPageRange } from "./pageRange";

import {
  getPdfSelectionSnapshot,
  subscribePdfSelection,
} from "./pdfSelectionStore";

import type { PdfSourceFileMeta } from "./pdfImport";

/** pages above this many ask for confirmation before expanding */
const EXPAND_CONFIRM_THRESHOLD = 20;
/** extracted page images render at this width (px) in the SD tier */
const EXTRACT_WIDTH_PX = 1440;
/** extracted page images render at this width (px) in the HD tier */
const EXTRACT_WIDTH_HD_PX = 2880;
/** scene-units offset below the element where page images are inserted */
const INSERT_OFFSET = 40;

const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
};

export const PdfToolbarHost: React.FC<{
  excalidrawAPI: ExcalidrawImperativeAPI;
}> = ({ excalidrawAPI }) => {
  const { t } = useI18n();
  const snapshot = useSyncExternalStore(
    subscribePdfSelection,
    getPdfSelectionSnapshot,
  );
  const [busy, setBusy] = useState(false);
  const [showExpand, setShowExpand] = useState(false);
  const [rangeStart, setRangeStart] = useState(1);
  const [rangeEnd, setRangeEnd] = useState(1);

  const element = snapshot.element;

  const extractPage = useCallback(async () => {
    if (!element || busy) {
      return;
    }
    const sourceFile = element.customData?.sourceFile as
      | PdfSourceFileMeta
      | undefined;
    const dataURL = sourceFile?.fileId
      ? excalidrawAPI.getFiles()[sourceFile.fileId]?.dataURL
      : undefined;
    if (!sourceFile || !dataURL) {
      return;
    }
    setBusy(true);
    try {
      const info = await openPdfData(dataURL);
      const page = sourceFile.currentPage ?? 1;
      // extract follows the element's quality tier (HD preview → HD extract)
      const width =
        sourceFile.hiRes === true ? EXTRACT_WIDTH_HD_PX : EXTRACT_WIDTH_PX;
      const blob = await fetchPdfPage(info.hash, page, width);
      await insertPageImages(
        [{ blob, pageNumber: page }],
        { x: element.x, y: element.y + element.height + INSERT_OFFSET },
        excalidrawAPI,
        sourceFile.fileId,
      );
    } finally {
      setBusy(false);
    }
  }, [element, busy, excalidrawAPI]);

  const expandPages = useCallback(async () => {
    if (!element || busy) {
      return;
    }
    const sourceFile = element.customData?.sourceFile as
      | PdfSourceFileMeta
      | undefined;
    const dataURL = sourceFile?.fileId
      ? excalidrawAPI.getFiles()[sourceFile.fileId]?.dataURL
      : undefined;
    if (!sourceFile || !dataURL) {
      return;
    }
    const pageCount = sourceFile.pageCount ?? 1;
    const { start, end } = clampPageRange(rangeStart, rangeEnd, pageCount);
    const count = end - start + 1;
    if (
      count > EXPAND_CONFIRM_THRESHOLD &&
      !window.confirm(t("mediaImport.expandPages"))
    ) {
      return;
    }
    setBusy(true);
    try {
      const info = await openPdfData(dataURL);
      const pages = Array.from({ length: count }, (_, i) => start + i);
      // extract follows the element's quality tier (HD preview → HD extract)
      const width =
        sourceFile.hiRes === true ? EXTRACT_WIDTH_HD_PX : EXTRACT_WIDTH_PX;
      const blobs = await mapWithConcurrency(pages, 4, async (pageNumber) => ({
        blob: await fetchPdfPage(info.hash, pageNumber, width),
        pageNumber,
      }));
      await insertPageImages(
        blobs,
        { x: element.x, y: element.y + element.height + INSERT_OFFSET },
        excalidrawAPI,
        sourceFile.fileId,
      );
    } finally {
      setBusy(false);
    }
  }, [element, busy, rangeStart, rangeEnd, excalidrawAPI, t]);

  if (!element) {
    return null;
  }

  const sourceFile = element.customData?.sourceFile as
    | PdfSourceFileMeta
    | undefined;
  const page = sourceFile?.currentPage ?? 1;
  const pageCount = Math.max(1, sourceFile?.pageCount ?? 1);
  const hiRes = sourceFile?.hiRes === true;
  const { scrollX, scrollY, zoom } = snapshot;

  const buttonStyle: React.CSSProperties = {
    background: "transparent",
    border: "1px solid rgba(255, 255, 255, 0.4)",
    borderRadius: 4,
    color: "#fff",
    cursor: "pointer",
    fontSize: 12,
    padding: "2px 8px",
    whiteSpace: "nowrap",
  };
  const inputStyle: React.CSSProperties = {
    width: 44,
    fontSize: 12,
    padding: "1px 4px",
    border: "1px solid rgba(255, 255, 255, 0.4)",
    borderRadius: 4,
    background: "rgba(255, 255, 255, 0.1)",
    color: "#fff",
  };

  return createPortal(
    <div
      style={{
        position: "absolute",
        left: (element.x + scrollX) * zoom + (element.width * zoom) / 2,
        transform: "translateX(-50%)",
        top: (element.y + scrollY + element.height) * zoom + 4,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        zIndex: 5,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 8px",
          background: "rgba(0, 0, 0, 0.8)",
          borderRadius: 6,
          color: "#fff",
          fontSize: 12,
        }}
      >
        <button
          type="button"
          style={buttonStyle}
          disabled={page <= 1}
          onClick={() => turnPdfPage(excalidrawAPI, element, page - 1)}
        >
          ◀
        </button>
        <span style={{ minWidth: 44, textAlign: "center" }}>
          {t("mediaImport.pageOf", { current: page, total: pageCount })}
        </span>
        <button
          type="button"
          style={buttonStyle}
          disabled={page >= pageCount}
          onClick={() => turnPdfPage(excalidrawAPI, element, page + 1)}
        >
          ▶
        </button>
        <button
          type="button"
          style={buttonStyle}
          disabled={busy}
          onClick={() => void extractPage()}
        >
          {t("mediaImport.extractPage")}
        </button>
        <button
          type="button"
          style={{
            ...buttonStyle,
            background: showExpand ? "rgba(255, 255, 255, 0.2)" : "transparent",
          }}
          disabled={busy}
          onClick={() => setShowExpand((prev) => !prev)}
        >
          {t("mediaImport.expandPages")}
        </button>
        <button
          type="button"
          title={t("mediaImport.hiResHint")}
          style={{
            ...buttonStyle,
            background: hiRes ? "rgba(255, 255, 255, 0.2)" : "transparent",
            fontWeight: hiRes ? 700 : 400,
          }}
          disabled={busy}
          onClick={() => togglePdfHiRes(excalidrawAPI, element)}
        >
          {t("mediaImport.hiRes")}
        </button>
      </div>
      {showExpand && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 8px",
            background: "rgba(0, 0, 0, 0.8)",
            borderRadius: 6,
            color: "#fff",
            fontSize: 12,
          }}
        >
          <label>{t("mediaImport.pageFrom")}</label>
          <input
            type="number"
            min={1}
            max={pageCount}
            value={rangeStart}
            onChange={(event) => setRangeStart(Number(event.target.value))}
            style={inputStyle}
          />
          <label>{t("mediaImport.pageTo")}</label>
          <input
            type="number"
            min={1}
            max={pageCount}
            value={rangeEnd}
            onChange={(event) => setRangeEnd(Number(event.target.value))}
            style={inputStyle}
          />
          <button
            type="button"
            style={buttonStyle}
            disabled={busy}
            onClick={() => void expandPages()}
          >
            {t("mediaImport.expand")}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
};
