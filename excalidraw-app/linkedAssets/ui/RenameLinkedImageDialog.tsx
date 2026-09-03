/**
 * Small modal dialog for renaming a linked image. Opened via the
 * renameImageTargetAtom (set through the library bridge's renameImage).
 * On confirm the file on disk is renamed too (see rename.ts); on conflict or
 * failure the element keeps its previous name.
 */

import { useEffect, useState } from "react";

import { useI18n } from "@excalidraw/excalidraw/i18n";
import { useExcalidrawAPI } from "@excalidraw/excalidraw";

import { useAtom } from "../../app-jotai";
import { renameLinkedImage } from "../rename";
import { renameImageTargetAtom } from "../state";

import type { LinkedFileMeta } from "../types";

export const RenameLinkedImageDialog = () => {
  const { t } = useI18n();
  const excalidrawAPI = useExcalidrawAPI();
  const [targetId, setTargetId] = useAtom(renameImageTargetAtom);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const element = targetId
    ? excalidrawAPI
        ?.getSceneElementsIncludingDeleted()
        .find((el) => el.id === targetId)
    : null;
  const meta = element?.customData?.linkedFile as LinkedFileMeta | undefined;

  // prefill with the current display name when the dialog opens
  useEffect(() => {
    if (meta) {
      setName(meta.displayName);
    }
  }, [targetId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!targetId || !meta || !excalidrawAPI) {
    return null;
  }

  const close = () => setTargetId(null);

  const submit = async () => {
    if (busy || !name.trim()) {
      return;
    }
    setBusy(true);
    try {
      if (await renameLinkedImage(excalidrawAPI, targetId, name)) {
        close();
      }
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
      onClick={close}
    >
      <div
        role="dialog"
        aria-label={t("linkedAssets.renameTitle")}
        style={{
          background: "var(--popup-bg-color, #fff)",
          color: "var(--color-on-surface, inherit)",
          borderRadius: "0.5rem",
          padding: "1rem",
          minWidth: 320,
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {t("linkedAssets.renameTitle")}
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void submit();
              } else if (event.key === "Escape") {
                close();
              }
            }}
            style={{ padding: "0.375rem 0.5rem" }}
          />
        </label>
        <div
          style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}
        >
          <button type="button" onClick={close}>
            {t("buttons.cancel")}
          </button>
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => void submit()}
          >
            {t("linkedAssets.renameConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
};
