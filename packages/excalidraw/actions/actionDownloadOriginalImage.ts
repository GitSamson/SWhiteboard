import { MIME_TYPES } from "@excalidraw/common";

import { CaptureUpdateAction, isImageElement } from "@excalidraw/element";

import type {
  ExcalidrawImageElement,
  NonDeleted,
} from "@excalidraw/element/types";

import { downloadIcon } from "../components/icons";

import { register } from "./register";

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

export const actionDownloadOriginalImage = register({
  name: "downloadOriginalImage",
  label: "labels.downloadOriginalImage",
  icon: downloadIcon,
  viewMode: true,
  trackEvent: { category: "menu" },
  keywords: ["image", "download", "original"],
  perform(elements, appState, _, app) {
    const selectedElements = app.scene.getSelectedElements({
      selectedElementIds: appState.selectedElementIds,
      includeBoundTextElement: true,
    });

    const imageElements = selectedElements.filter(
      (element): element is NonDeleted<ExcalidrawImageElement> =>
        isImageElement(element) &&
        !!element.fileId &&
        !!app.files[element.fileId]?.dataURL,
    );

    const doc = app.ownerDocument;

    // stagger the downloads — some browsers throttle/block multiple
    // programmatic downloads fired within the same task
    imageElements.forEach((element, index) => {
      const fileData = app.files[element.fileId!]!;
      const extension =
        EXTENSION_BY_MIME_TYPE[fileData.mimeType] ||
        fileData.mimeType.split("/")[1] ||
        "png";

      const download = () => {
        const anchor = doc.createElement("a");
        anchor.href = fileData.dataURL;
        anchor.download =
          imageElements.length > 1
            ? `${index + 1}-${element.id}.${extension}`
            : `${element.id}.${extension}`;
        doc.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      };

      if (index === 0) {
        download();
      } else {
        app.ownerWindow.setTimeout(download, index * 150);
      }
    });

    return {
      captureUpdate: CaptureUpdateAction.NEVER,
      appState:
        imageElements.length > 1
          ? {
              toast: {
                message: `Downloading ${imageElements.length} images…`,
                duration: 2000,
              },
            }
          : undefined,
    };
  },
  predicate: (elements, appState, _, app) => {
    const selectedElements = app.scene.getSelectedElements(appState);
    return selectedElements.some(
      (element) =>
        isImageElement(element) &&
        !!element.fileId &&
        !!app.files[element.fileId]?.dataURL,
    );
  },
});
