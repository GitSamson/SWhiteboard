import { PDFDocument } from "pdf-lib";

import { CaptureUpdateAction } from "@excalidraw/element";

import { canvasToBlob } from "../data/blob";

import { downloadIcon } from "../components/icons";

import { t } from "../i18n";

import { exportToCanvas } from "../scene/export";

import { prepareOriginalQualityExport } from "./exportOriginalQuality";
import { register } from "./register";

const blobToUint8Array = (blob: Blob): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });

export const actionExportPdf = register({
  name: "exportPdf",
  label: "labels.exportPdf",
  icon: downloadIcon,
  viewMode: true,
  trackEvent: { category: "export" },
  keywords: ["image", "download", "export", "pdf", "high quality"],
  perform: async (elements, appState, _, app) => {
    const { selectedElements, scale, files, exportWidth, exportHeight } =
      await prepareOriginalQualityExport(app, appState);

    try {
      const canvas = await exportToCanvas(
        selectedElements,
        { ...appState, exportScale: scale },
        files,
        {
          exportBackground: appState.exportBackground,
          viewBackgroundColor: appState.viewBackgroundColor,
          forceOriginalImages: true,
        },
      );

      const pngBytes = await blobToUint8Array(await canvasToBlob(canvas));

      // css px → PDF pt; the 16384px export ceiling × 0.75 = 12288pt stays
      // below pdf-lib's 14400pt page-size limit
      const pageWidth = exportWidth * 0.75;
      const pageHeight = exportHeight * 0.75;
      const doc = await PDFDocument.create();
      const page = doc.addPage([pageWidth, pageHeight]);
      const image = await doc.embedPng(pngBytes);
      page.drawImage(image, {
        x: 0,
        y: 0,
        width: pageWidth,
        height: pageHeight,
      });
      const pdfBytes = await doc.save();

      const pdfBlob = new Blob([pdfBytes.buffer as ArrayBuffer], {
        type: "application/pdf",
      });

      const docEl = app.ownerDocument;
      const objectUrl = app.ownerWindow.URL.createObjectURL(pdfBlob);
      const anchor = docEl.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${appState.name?.trim() || "untitled"}-高清.pdf`;
      docEl.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      app.ownerWindow.URL.revokeObjectURL(objectUrl);
    } catch (error: any) {
      console.warn(error);
      app.setToast({
        message:
          error?.name === "CANVAS_POSSIBLY_TOO_BIG"
            ? t("canvasError.canvasTooBig")
            : "Failed to export PDF.",
      });
    }

    return {
      captureUpdate: CaptureUpdateAction.NEVER,
    };
  },
  predicate: (elements, appState, _, app) => {
    const selectedElements = app.scene.getSelectedElements(appState);
    return selectedElements.length > 0;
  },
});
