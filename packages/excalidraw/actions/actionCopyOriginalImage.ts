/**
 * Copies the ORIGINAL image data of the selected image element to the
 * clipboard — never the (possibly downscaled/compressed) embedded webp
 * thumbnail: linked images are resolved from disk through the linked-assets
 * bridge, embedded images already hold their original bytes in BinaryFiles.
 *
 * The clipboard only accepts `image/png`, so the original pixels are
 * re-encoded as lossless PNG at full resolution (GIF loses animation, SVG
 * is rasterized — inherent to clipboard image copies).
 */

import { CaptureUpdateAction, isImageElement } from "@excalidraw/element";

import type {
  ExcalidrawImageElement,
  NonDeleted,
} from "@excalidraw/element/types";

import { copyIcon } from "../components/icons";

import { t } from "../i18n";

import { getLinkedAssetsBridge } from "../linkedAssetsBridge";

import { register } from "./register";

import type { AppClassProperties } from "../types";
import type { DataURL } from "../types";

interface LinkedFileMetaLike {
  placeholder?: boolean;
}

/** decodes `dataURL` and re-encodes it as a lossless PNG blob */
const dataURLToPngBlob = async (
  dataURL: DataURL,
  app: AppClassProperties,
): Promise<Blob> => {
  const doc = app.ownerDocument;
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = doc.createElement("img");
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode original image"));
    img.src = dataURL;
  });
  const canvas = doc.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D context is not available");
  }
  context.drawImage(image, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
  if (!blob) {
    throw new Error("Failed to encode image as PNG");
  }
  return blob;
};

export const actionCopyOriginalImage = register({
  name: "copyOriginalImage",
  label: "labels.copyOriginalImage",
  icon: copyIcon,
  viewMode: true,
  trackEvent: { category: "menu" },
  keywords: ["image", "copy", "original", "clipboard"],
  perform: async (elements, appState, _, app) => {
    const selectedElements = app.scene.getSelectedElements({
      selectedElementIds: appState.selectedElementIds,
      includeBoundTextElement: true,
    });

    const element = selectedElements.find(
      (el): el is NonDeleted<ExcalidrawImageElement> =>
        isImageElement(el) && !!el.fileId && !!app.files[el.fileId]?.dataURL,
    );

    if (!element) {
      return { captureUpdate: CaptureUpdateAction.NEVER };
    }

    // the clipboard payload is a promise so the (potentially slow) disk read
    // + PNG re-encode doesn't break the transient user activation
    let originalUnavailable = false;
    const pngBlobPromise = (async () => {
      const fileData = app.files[element.fileId!]!;
      let dataURL = fileData.dataURL;
      if (element.customData?.linkedFile) {
        const bridge = getLinkedAssetsBridge();
        // user gesture: the interactive resolver may prompt for the folder
        // permission instead of silently giving up
        const original = await (bridge?.resolveOriginalInteractive?.(
          element.fileId!,
          fileData,
        ) ?? bridge?.resolveOriginal(element.fileId!, fileData));
        if (!original) {
          // never silently downgrade to the compressed thumbnail
          originalUnavailable = true;
          throw new Error("linked original is unavailable");
        }
        dataURL = original;
      }
      return dataURLToPngBlob(dataURL, app);
    })();

    try {
      const clipboard = app.ownerWindow.navigator.clipboard;
      await clipboard.write([
        new app.ownerWindow.ClipboardItem({
          "image/png": pngBlobPromise,
        }),
      ]);
      await pngBlobPromise; // surface encoding failures as the error toast
      app.setToast({ message: t("toast.copyOriginalImageSuccess") });
    } catch (error) {
      console.warn(error);
      app.setToast({
        message: originalUnavailable
          ? t("toast.copyOriginalImageReconnect")
          : t("toast.copyOriginalImageError"),
      });
    }

    return {
      captureUpdate: CaptureUpdateAction.NEVER,
    };
  },
  predicate: (elements, appState, _, app) => {
    const selectedElements = app.scene.getSelectedElements(appState);
    return selectedElements.some(
      (element) =>
        isImageElement(element) &&
        !!element.fileId &&
        !!app.files[element.fileId]?.dataURL &&
        // file-icon placeholders link non-image files — there is no
        // original image to copy
        !(element.customData?.linkedFile as LinkedFileMetaLike | undefined)
          ?.placeholder,
    );
  },
});
