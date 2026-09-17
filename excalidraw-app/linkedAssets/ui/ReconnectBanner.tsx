/**
 * Banner shown when sync frames' folders are no longer connected — after
 * reopening a saved scene the File System Access permission is gone
 * ("needs-permission": the persisted handle can be re-authorized) or the
 * folder handle was never seen by this browser ("handle-missing": the user
 * must pick the folder again). Both actions run in the click handler, i.e.
 * inside a user gesture, because browsers reject permission requests
 * without one.
 */

import { useI18n } from "@excalidraw/excalidraw/i18n";
import { useExcalidrawAPI } from "@excalidraw/excalidraw";

import { useAtom } from "../../app-jotai";
import {
  connectedFoldersAtom,
  folderConnectionStatusAtom,
  missingLinkedCountAtom,
} from "../state";
import { reconnectFolder, relinkFolder } from "../reconnect";

export const ReconnectBanner = () => {
  const { t } = useI18n();
  const excalidrawAPI = useExcalidrawAPI();
  const [statuses] = useAtom(folderConnectionStatusAtom);
  const [folders] = useAtom(connectedFoldersAtom);
  const [missingCount] = useAtom(missingLinkedCountAtom);

  if (!excalidrawAPI) {
    return null;
  }

  const disconnected = Object.entries(statuses).filter(
    ([, status]) => status !== "connected",
  );
  if (!disconnected.length) {
    return null;
  }

  // keep clear of the missing-linked banner when both are shown
  const top = missingCount ? "3.25rem" : "0.5rem";

  return (
    <div
      style={{
        position: "absolute",
        top,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 3,
        display: "flex",
        flexDirection: "column",
        gap: "0.375rem",
        padding: "0.5rem 0.75rem",
        borderRadius: "0.5rem",
        background: "var(--color-warning, #f08c00)",
        color: "#fff",
        fontSize: "0.875rem",
        maxWidth: "min(90vw, 34rem)",
      }}
      role="alert"
    >
      {disconnected.map(([folderId, status]) => {
        const name = folders[folderId]?.rootName ?? folderId;
        return (
          <div
            key={folderId}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {status === "handle-missing"
                ? t("linkedAssets.relinkBanner", { name })
                : t("linkedAssets.reconnectBanner", { name })}
            </span>
            <button
              type="button"
              onClick={() => {
                if (status === "handle-missing") {
                  void relinkFolder(excalidrawAPI, folderId);
                } else {
                  void reconnectFolder(excalidrawAPI, folderId);
                }
              }}
              style={{
                flexShrink: 0,
                border: "1px solid rgba(255, 255, 255, 0.6)",
                borderRadius: "0.375rem",
                background: "transparent",
                color: "inherit",
                padding: "0.25rem 0.5rem",
                cursor: "pointer",
              }}
            >
              {status === "handle-missing"
                ? t("linkedAssets.relinkButton")
                : t("linkedAssets.reconnectButton")}
            </button>
          </div>
        );
      })}
    </div>
  );
};
