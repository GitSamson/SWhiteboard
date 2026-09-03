/**
 * Sidebar tab for the "linked file assets" feature: lists the sync frames on
 * the current scene (each is bound to a folder). Clicking an entry scrolls
 * the viewport to the frame and selects it.
 */

import { useEffect, useState } from "react";

import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { useI18n } from "@excalidraw/excalidraw/i18n";

import { isFrameElement } from "@excalidraw/element";

import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
} from "@excalidraw/element/types";

import type { SyncFolderMeta } from "../types";

interface SyncFrameInfo {
  id: string;
  title: string;
  fileCount: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

const collectSyncFrames = (
  elements: readonly ExcalidrawElement[],
): SyncFrameInfo[] =>
  elements
    .filter(
      (el): el is ExcalidrawFrameElement =>
        isFrameElement(el) && !el.isDeleted && !!el.customData?.syncFolder,
    )
    .map((el) => {
      const syncFolder = el.customData!.syncFolder as SyncFolderMeta;
      return {
        id: el.id,
        title: el.name || syncFolder.rootName,
        fileCount: Object.keys(syncFolder.manifest).length,
        x: el.x,
        y: el.y,
        width: el.width,
        height: el.height,
      };
    });

export const SyncFoldersPanel = () => {
  const { t } = useI18n();
  const excalidrawAPI = useExcalidrawAPI();
  const [frames, setFrames] = useState<SyncFrameInfo[]>([]);

  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    setFrames(collectSyncFrames(excalidrawAPI.getSceneElements()));
    return excalidrawAPI.onChange((elements) => {
      setFrames(collectSyncFrames(elements));
    });
  }, [excalidrawAPI]);

  if (!excalidrawAPI) {
    return null;
  }

  const scrollToFrame = (frame: SyncFrameInfo) => {
    const appState = excalidrawAPI.getAppState();
    const zoom = appState.zoom.value;
    excalidrawAPI.updateScene({
      appState: {
        scrollX: appState.width / (2 * zoom) - (frame.x + frame.width / 2),
        scrollY: appState.height / (2 * zoom) - (frame.y + frame.height / 2),
        selectedElementIds: { [frame.id]: true },
      },
    });
  };

  return (
    <div className="px-3">
      <h3 style={{ fontSize: "0.875rem", margin: "0.75rem 0 0.5rem" }}>
        {t("linkedAssets.syncFoldersTitle")}
      </h3>
      {frames.length === 0 ? (
        <p style={{ fontSize: "0.8125rem", opacity: 0.7 }}>
          {t("linkedAssets.syncFoldersEmpty")}
        </p>
      ) : (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.25rem",
          }}
        >
          {frames.map((frame) => (
            <li key={frame.id}>
              <button
                type="button"
                onClick={() => scrollToFrame(frame)}
                style={{
                  width: "100%",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "0.5rem",
                  padding: "0.375rem 0.5rem",
                  border: "1px solid var(--default-border-color)",
                  borderRadius: "0.375rem",
                  background: "transparent",
                  color: "inherit",
                  fontSize: "0.8125rem",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {frame.title}
                </span>
                <span style={{ opacity: 0.6, flexShrink: 0 }}>
                  {t("linkedAssets.syncFolderFileCount", {
                    count: frame.fileCount,
                  })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
