/**
 * App-layer renderer for LEGACY pdf embeddable elements (scenes saved before
 * pdf became a native element type). New imports create `pdf` elements that
 * render through the static canvas pipeline; old `embeddable` elements with
 * `customData.sourceFile.kind === "pdf"` land here.
 *
 * Keeping the old client-side pdfjs renderer alive just for these would mean
 * maintaining two render stacks, so the legacy box shows a re-import hint and
 * offers the source file for download instead. The binary stays in
 * BinaryFiles, so nothing is lost on save/load.
 */

import { useI18n } from "@excalidraw/excalidraw/i18n";

import type { ExcalidrawEmbeddableElement } from "@excalidraw/element/types";
import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import type { PdfSourceFileMeta } from "./pdfImport";

export const PdfEmbedWidget: React.FC<{
  element: ExcalidrawEmbeddableElement;
  appState: AppState;
  excalidrawAPI: ExcalidrawImperativeAPI;
}> = ({ element, appState, excalidrawAPI }) => {
  const { t } = useI18n();
  const sourceFile = element.customData?.sourceFile as
    | PdfSourceFileMeta
    | undefined;

  const downloadSource = () => {
    const fileId = sourceFile?.fileId;
    const dataURL = fileId ? excalidrawAPI.getFiles()[fileId]?.dataURL : null;
    if (!dataURL) {
      return;
    }
    const anchor = document.createElement("a");
    anchor.href = dataURL;
    anchor.download = sourceFile?.name || "document.pdf";
    anchor.click();
  };

  void appState; // kept for renderEmbeddable's component signature

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        background: "#fff",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        color: "#868e96",
        fontSize: 13,
        textAlign: "center",
        padding: 8,
      }}
    >
      <div>{t("mediaImport.legacyPdfEmbed")}</div>
      <button
        type="button"
        onClick={downloadSource}
        style={{
          background: "transparent",
          border: "1px solid #ced4da",
          borderRadius: 4,
          color: "#495057",
          cursor: "pointer",
          fontSize: 12,
          padding: "2px 8px",
        }}
      >
        {t("mediaImport.downloadSource")}
      </button>
    </div>
  );
};
