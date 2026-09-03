/**
 * Banner shown when linked image elements are marked "missing" (their file
 * disappeared from the bound folder). Offers a one-click removal of all
 * missing linked images; the removal goes through CaptureUpdateAction
 * .IMMEDIATELY so it is undoable.
 */

import { useI18n } from "@excalidraw/excalidraw/i18n";
import { useExcalidrawAPI } from "@excalidraw/excalidraw";

import { CaptureUpdateAction, newElementWith } from "@excalidraw/element";

import { useAtom } from "../../app-jotai";
import { missingLinkedCountAtom } from "../state";

export const MissingLinkedBanner = () => {
  const { t } = useI18n();
  const excalidrawAPI = useExcalidrawAPI();
  const [missingCount] = useAtom(missingLinkedCountAtom);

  if (!missingCount || !excalidrawAPI) {
    return null;
  }

  const clearMissing = () => {
    const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
    const next = elements.map((element) =>
      !element.isDeleted && element.customData?.linkedFile?.status === "missing"
        ? newElementWith(element, { isDeleted: true })
        : element,
    );
    excalidrawAPI.updateScene({
      elements: next,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  };

  return (
    <div
      style={{
        position: "absolute",
        top: "0.5rem",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 3,
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        padding: "0.5rem 0.75rem",
        borderRadius: "0.5rem",
        background: "var(--color-danger, #e03131)",
        color: "#fff",
        fontSize: "0.875rem",
      }}
      role="alert"
    >
      <span>{t("linkedAssets.missingBanner", { count: missingCount })}</span>
      <button
        type="button"
        onClick={clearMissing}
        style={{
          border: "1px solid rgba(255, 255, 255, 0.6)",
          borderRadius: "0.375rem",
          background: "transparent",
          color: "inherit",
          padding: "0.25rem 0.5rem",
          cursor: "pointer",
        }}
      >
        {t("linkedAssets.clearMissing")}
      </button>
    </div>
  );
};
