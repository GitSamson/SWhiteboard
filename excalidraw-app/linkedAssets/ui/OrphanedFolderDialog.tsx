/**
 * Prompt shown after a sync frame with linked files was deleted on the
 * board: the user chooses whether the folder's images should be removed
 * from the board too. The files on disk are never touched; either way the
 * images are unlinked afterwards.
 */

import { useState } from "react";

import { useI18n } from "@excalidraw/excalidraw/i18n";
import { useExcalidrawAPI } from "@excalidraw/excalidraw";

import { useAtom } from "../../app-jotai";
import { deleteFolderImages, unlinkFolderLinks } from "../frameActions";
import { orphanedSyncFolderAtom } from "../state";

export const OrphanedFolderDialog = () => {
  const { t } = useI18n();
  const excalidrawAPI = useExcalidrawAPI();
  const [orphaned, setOrphaned] = useAtom(orphanedSyncFolderAtom);
  const [busy, setBusy] = useState(false);

  if (!orphaned || !excalidrawAPI) {
    return null;
  }

  const finish = async (deleteImages: boolean) => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      if (deleteImages) {
        // board images first: unlinkFolderLinks strips the metadata this
        // lookup relies on
        deleteFolderImages(excalidrawAPI, orphaned.folderId);
      }
      unlinkFolderLinks(excalidrawAPI, orphaned.folderId);
      setOrphaned(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.4)",
      }}
      onClick={() => void finish(false)}
    >
      <div
        role="dialog"
        aria-label={t("linkedAssets.orphanedTitle")}
        style={{
          background: "var(--popup-bg-color, #fff)",
          color: "var(--color-on-surface, inherit)",
          borderRadius: "0.5rem",
          padding: "1rem",
          minWidth: 320,
          maxWidth: 420,
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ fontWeight: 600 }}>{t("linkedAssets.orphanedTitle")}</div>
        <div style={{ fontSize: "0.875rem" }}>
          {t("linkedAssets.orphanedMessage", {
            folder: orphaned.rootName,
            count: orphaned.relPaths.length,
          })}
        </div>
        <div
          style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}
        >
          <button
            type="button"
            disabled={busy}
            onClick={() => void finish(false)}
          >
            {t("linkedAssets.orphanedKeep")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void finish(true)}
            style={{
              background: "var(--color-danger, #e03131)",
              color: "#fff",
              border: "none",
              borderRadius: "0.375rem",
              padding: "0.375rem 0.75rem",
              cursor: "pointer",
            }}
          >
            {t("linkedAssets.orphanedDelete")}
          </button>
        </div>
      </div>
    </div>
  );
};
