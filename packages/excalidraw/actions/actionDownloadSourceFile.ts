import { MIME_TYPES } from "@excalidraw/common";

import { CaptureUpdateAction } from "@excalidraw/element";

import { downloadIcon } from "../components/icons";

import { register } from "./register";

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  [MIME_TYPES.pdf]: "pdf",
  [MIME_TYPES.videoMp4]: "mp4",
  [MIME_TYPES.videoWebm]: "webm",
  [MIME_TYPES.videoQuickTime]: "mov",
};

export const actionDownloadSourceFile = register({
  name: "downloadSourceFile",
  label: "labels.downloadSourceFile",
  icon: downloadIcon,
  viewMode: true,
  trackEvent: { category: "menu" },
  keywords: ["source", "download", "file"],
  perform(elements, appState, _, app) {
    const selectedElements = app.scene.getSelectedElements({
      selectedElementIds: appState.selectedElementIds,
      includeBoundTextElement: false,
    });

    const sourceElement = selectedElements.find(
      (element) =>
        !!element.customData?.sourceFile?.fileId &&
        !!app.files[element.customData.sourceFile.fileId]?.dataURL,
    );

    if (sourceElement) {
      const { fileId, name } = sourceElement.customData!.sourceFile!;
      const fileData = app.files[fileId]!;
      const extension =
        EXTENSION_BY_MIME_TYPE[fileData.mimeType] ||
        fileData.mimeType.split("/")[1] ||
        "bin";

      const doc = app.ownerDocument;
      const anchor = doc.createElement("a");
      anchor.href = fileData.dataURL;
      anchor.download = `${name || "source"}.${extension}`;
      doc.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    }

    return {
      captureUpdate: CaptureUpdateAction.NEVER,
    };
  },
  predicate: (elements, appState, _, app) => {
    const selectedElements = app.scene.getSelectedElements(appState);
    // only show for a single selected element carrying a sourceFile ref
    return (
      selectedElements.length === 1 &&
      selectedElements.some(
        (element) =>
          !!element.customData?.sourceFile?.fileId &&
          !!app.files[element.customData.sourceFile.fileId]?.dataURL,
      )
    );
  },
});
