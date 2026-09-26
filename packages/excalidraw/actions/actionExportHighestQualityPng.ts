import { CaptureUpdateAction } from "@excalidraw/element";

import { canvasToBlob } from "../data/blob";

import { downloadIcon } from "../components/icons";

import { t } from "../i18n";

import { exportToCanvas } from "../scene/export";

import { prepareOriginalQualityExport } from "./exportOriginalQuality";
import { register } from "./register";

export const actionExportHighestQualityPng = register({
  name: "exportHighestQualityPng",
  label: "labels.exportHighestQualityPng",
  icon: downloadIcon,
  viewMode: true,
  trackEvent: { category: "export" },
  keywords: ["image", "download", "export", "png", "high quality"],
  perform: async (elements, appState, _, app) => {
    const { selectedElements, scale, files } =
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

      const blob = await canvasToBlob(canvas);

      const doc = app.ownerDocument;
      const objectUrl = app.ownerWindow.URL.createObjectURL(blob);
      const anchor = doc.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${appState.name?.trim() || "untitled"}-高清.png`;
      doc.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      app.ownerWindow.URL.revokeObjectURL(objectUrl);
    } catch (error: any) {
      console.warn(error);
      app.setToast({
        message:
          error?.name === "CANVAS_POSSIBLY_TOO_BIG"
            ? t("canvasError.canvasTooBig")
            : "Failed to export PNG.",
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
