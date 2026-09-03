import { CaptureUpdateAction, isImageElement } from "@excalidraw/element";

import type {
  ExcalidrawImageElement,
  NonDeleted,
} from "@excalidraw/element/types";

import { EmbedIcon, LinkIcon, pencilIcon } from "../components/icons";

import { getLinkedAssetsBridge } from "../linkedAssetsBridge";

import { register } from "./register";

export const actionConvertToLinked = register({
  name: "convertToLinked",
  label: "labels.convertToLinked",
  icon: LinkIcon,
  viewMode: false,
  trackEvent: { category: "menu" },
  keywords: ["image", "link", "folder", "sync"],
  perform(elements, appState, _, app) {
    const imageElements = app.scene
      .getSelectedElements(appState)
      .filter(
        (element): element is NonDeleted<ExcalidrawImageElement> =>
          isImageElement(element) &&
          !!element.fileId &&
          !element.customData?.linkedFile &&
          !!app.files[element.fileId]?.dataURL,
      );

    // fire-and-forget: the app-layer service reports progress/errors via toast
    try {
      void getLinkedAssetsBridge()?.convertToLinked(imageElements);
    } catch (error) {
      console.error(error);
    }

    return {
      captureUpdate: CaptureUpdateAction.NEVER,
    };
  },
  predicate: (elements, appState, _, app) => {
    if (!getLinkedAssetsBridge()) {
      return false;
    }
    return app.scene
      .getSelectedElements(appState)
      .some(
        (element) =>
          isImageElement(element) &&
          !!element.fileId &&
          !element.customData?.linkedFile &&
          !!app.files[element.fileId]?.dataURL,
      );
  },
});

export const actionConvertToEmbedded = register({
  name: "convertToEmbedded",
  label: "labels.convertToEmbedded",
  icon: EmbedIcon,
  viewMode: false,
  trackEvent: { category: "menu" },
  keywords: ["image", "embed", "folder", "sync"],
  perform(elements, appState, _, app) {
    const imageElements = app.scene
      .getSelectedElements(appState)
      .filter(
        (element): element is NonDeleted<ExcalidrawImageElement> =>
          isImageElement(element) &&
          !!element.fileId &&
          !!element.customData?.linkedFile,
      );

    // fire-and-forget: the app-layer service reports progress/errors via toast
    try {
      void getLinkedAssetsBridge()?.convertToEmbedded(imageElements);
    } catch (error) {
      console.error(error);
    }

    return {
      captureUpdate: CaptureUpdateAction.NEVER,
    };
  },
  predicate: (elements, appState, _, app) => {
    if (!getLinkedAssetsBridge()) {
      return false;
    }
    return app.scene
      .getSelectedElements(appState)
      .some(
        (element) =>
          isImageElement(element) &&
          !!element.fileId &&
          !!element.customData?.linkedFile,
      );
  },
});

export const actionRenameLinkedImage = register({
  name: "renameLinkedImage",
  label: "labels.renameLinkedImage",
  icon: pencilIcon,
  viewMode: true,
  trackEvent: { category: "menu" },
  keywords: ["image", "rename", "file", "link"],
  perform(elements, appState, _, app) {
    const imageElement = app.scene
      .getSelectedElements(appState)
      .find(
        (element): element is NonDeleted<ExcalidrawImageElement> =>
          isImageElement(element) && !!element.customData?.linkedFile,
      );

    if (imageElement) {
      try {
        getLinkedAssetsBridge()?.renameImage(imageElement);
      } catch (error) {
        console.error(error);
      }
    }

    return {
      captureUpdate: CaptureUpdateAction.NEVER,
    };
  },
  predicate: (elements, appState, _, app) => {
    if (!getLinkedAssetsBridge()) {
      return false;
    }
    const linkedImages = app.scene
      .getSelectedElements(appState)
      .filter(
        (element) =>
          isImageElement(element) && !!element.customData?.linkedFile,
      );
    // rename only makes sense for a single image
    return linkedImages.length === 1;
  },
});
