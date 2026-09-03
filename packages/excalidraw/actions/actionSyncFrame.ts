import { CaptureUpdateAction, isFrameElement } from "@excalidraw/element";

import type {
  ExcalidrawFrameElement,
  NonDeleted,
} from "@excalidraw/element/types";

import { eyeIcon, TrashIcon, ZoomResetIcon } from "../components/icons";

import { getLinkedAssetsBridge } from "../linkedAssetsBridge";

import { register } from "./register";

import type { AppClassProperties, AppState } from "../types";

const getSelectedSyncFrame = (
  appState: AppState,
  app: AppClassProperties,
): NonDeleted<ExcalidrawFrameElement> | undefined =>
  app.scene
    .getSelectedElements(appState)
    .find(
      (element): element is NonDeleted<ExcalidrawFrameElement> =>
        isFrameElement(element) && !!element.customData?.syncFolder,
    );

export const actionShowHiddenImages = register({
  name: "showHiddenImages",
  label: "labels.showHiddenImages",
  icon: eyeIcon,
  viewMode: false,
  trackEvent: { category: "menu" },
  keywords: ["image", "hidden", "folder", "sync", "frame"],
  perform(elements, appState, _, app) {
    const frame = getSelectedSyncFrame(appState, app);
    if (frame) {
      try {
        getLinkedAssetsBridge()?.showHiddenImages(frame);
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
    return !!getSelectedSyncFrame(appState, app);
  },
});

export const actionDeleteHiddenImages = register({
  name: "deleteHiddenImages",
  label: "labels.deleteHiddenImages",
  icon: TrashIcon,
  viewMode: false,
  trackEvent: { category: "menu" },
  keywords: ["image", "hidden", "delete", "folder", "sync", "frame"],
  perform(elements, appState, _, app) {
    const frame = getSelectedSyncFrame(appState, app);
    // fire-and-forget: the app-layer service reports progress/errors via toast
    if (frame) {
      try {
        void getLinkedAssetsBridge()?.deleteHiddenImages(frame);
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
    return !!getSelectedSyncFrame(appState, app);
  },
});

export const actionResetSyncFrameLayout = register({
  name: "resetSyncFrameLayout",
  label: "labels.resetSyncFrameLayout",
  icon: ZoomResetIcon,
  viewMode: false,
  trackEvent: { category: "menu" },
  keywords: ["image", "layout", "reset", "folder", "sync", "frame"],
  perform(elements, appState, _, app) {
    const frame = getSelectedSyncFrame(appState, app);
    if (frame) {
      try {
        getLinkedAssetsBridge()?.resetSyncFrameLayout(frame);
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
    return !!getSelectedSyncFrame(appState, app);
  },
});
