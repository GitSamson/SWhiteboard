/**
 * Sidebar tab for the "linked file assets" feature: lists the sync frames on
 * the current scene (each is bound to a folder). Clicking an entry scrolls
 * the viewport to the frame and selects it; the expand triangle reveals the
 * folder's synced files.
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
  fileNames: string[];
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
        fileNames: Object.keys(syncFolder.manifest),
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
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );

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

  const toggleExpanded = (frameId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(frameId)) {
        next.delete(frameId);
      } else {
        next.add(frameId);
      }
      return next;
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
          {frames.map((frame) => {
            const expanded = expandedIds.has(frame.id);
            return (
              <li key={frame.id}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.25rem",
                  }}
                >
                  <button
                    type="button"
                    aria-label={
                      expanded
                        ? t("linkedAssets.syncFolderCollapse")
                        : t("linkedAssets.syncFolderExpand")
                    }
                    onClick={() => toggleExpanded(frame.id)}
                    style={{
                      flexShrink: 0,
                      width: "1.25rem",
                      border: "none",
                      background: "transparent",
                      color: "inherit",
                      cursor: "pointer",
                      padding: 0,
                      fontSize: "0.75rem",
                      lineHeight: 1,
                    }}
                  >
                    {expanded ? "▾" : "▸"}
                  </button>
                  <button
                    type="button"
                    onClick={() => scrollToFrame(frame)}
                    style={{
                      flex: 1,
                      minWidth: 0,
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
                        count: frame.fileNames.length,
                      })}
                    </span>
                  </button>
                </div>
                {expanded && (
                  <ul
                    style={{
                      listStyle: "none",
                      padding: 0,
                      margin: "0.25rem 0 0 1.5rem",
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.125rem",
                    }}
                  >
                    {frame.fileNames.map((fileName) => (
                      <li
                        key={fileName}
                        title={fileName}
                        style={{
                          fontSize: "0.75rem",
                          opacity: 0.75,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {fileName}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
