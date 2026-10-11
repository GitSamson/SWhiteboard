/**
 * Toolbar host for the native `pdf` element type: the shared floating icon
 * pill (`media/ElementToolbar`), hovering ABOVE the selected element's box.
 * Page turns go through `turnPdfPage` (NEVER captured in undo history);
 * "extract"/"expand" rasterize pages on the dev server and insert them as
 * regular image elements. The expand page-range inputs live in a popover
 * under the pill; the HD toggle switches the preview/extract quality tier.
 */

import { useCallback, useState, useSyncExternalStore } from "react";

import { useI18n } from "@excalidraw/excalidraw/i18n";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  ElementToolbar,
  ToolbarDivider,
  ToolbarIconButton,
  ToolbarPopover,
} from "../media/ElementToolbar";
import {
  ToolbarChevronLeftIcon,
  ToolbarChevronRightIcon,
  ToolbarHdMark,
  ToolbarImageDownIcon,
  ToolbarLayersIcon,
} from "../media/toolbarIcons";

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

const rangeInputStyle: React.CSSProperties = {
  width: 44,
  fontSize: 12,
  padding: "2px 4px",
  border: "1px solid rgba(0, 0, 0, 0.15)",
  borderRadius: 6,
  background: "#fff",
  color: "#242529",
};

const popoverButtonStyle: React.CSSProperties = {
  background: "#242529",
  border: "none",
  borderRadius: 6,
  color: "#fff",
  cursor: "pointer",
  fontSize: 12,
  padding: "4px 10px",
  whiteSpace: "nowrap",
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
  const [expandOpen, setExpandOpen] = useState(false);
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
      // extracted page matches the control's size (width = element width,
      // height follows the page aspect ratio)
      await insertPageImages(
        [{ blob, pageNumber: page }],
        { x: element.x, y: element.y + element.height + INSERT_OFFSET },
        excalidrawAPI,
        sourceFile.fileId,
        element.width,
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
      setExpandOpen(false);
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

  return (
    <ElementToolbar
      element={element}
      viewport={{ scrollX, scrollY, zoom }}
      onPointerDownOutside={expandOpen ? () => setExpandOpen(false) : undefined}
    >
      <ToolbarIconButton
        label={t("mediaImport.prevPage")}
        disabled={page <= 1}
        onClick={() => turnPdfPage(excalidrawAPI, element, page - 1)}
      >
        <ToolbarChevronLeftIcon />
      </ToolbarIconButton>
      <span
        style={{
          minWidth: 44,
          textAlign: "center",
          fontSize: 12,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {t("mediaImport.pageOf", { current: page, total: pageCount })}
      </span>
      <ToolbarIconButton
        label={t("mediaImport.nextPage")}
        disabled={page >= pageCount}
        onClick={() => turnPdfPage(excalidrawAPI, element, page + 1)}
      >
        <ToolbarChevronRightIcon />
      </ToolbarIconButton>
      <ToolbarDivider />
      <ToolbarIconButton
        label={t("mediaImport.extractPage")}
        disabled={busy}
        onClick={() => void extractPage()}
      >
        <ToolbarImageDownIcon />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={t("mediaImport.expandPages")}
        active={expandOpen}
        disabled={busy}
        onClick={() => setExpandOpen((prev) => !prev)}
      >
        <ToolbarLayersIcon />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={t("mediaImport.hiRes")}
        active={hiRes}
        disabled={busy}
        onClick={() => togglePdfHiRes(excalidrawAPI, element)}
      >
        <ToolbarHdMark active={hiRes} />
      </ToolbarIconButton>
      {expandOpen && (
        <ToolbarPopover>
          <label>{t("mediaImport.pageFrom")}</label>
          <input
            type="number"
            min={1}
            max={pageCount}
            value={rangeStart}
            onChange={(event) => setRangeStart(Number(event.target.value))}
            style={rangeInputStyle}
          />
          <label>{t("mediaImport.pageTo")}</label>
          <input
            type="number"
            min={1}
            max={pageCount}
            value={rangeEnd}
            onChange={(event) => setRangeEnd(Number(event.target.value))}
            style={rangeInputStyle}
          />
          <button
            type="button"
            style={popoverButtonStyle}
            disabled={busy}
            onClick={() => void expandPages()}
          >
            {t("mediaImport.expand")}
          </button>
        </ToolbarPopover>
      )}
    </ElementToolbar>
  );
};
