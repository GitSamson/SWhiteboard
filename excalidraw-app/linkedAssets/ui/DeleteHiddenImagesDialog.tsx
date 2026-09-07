/**
 * Confirmation dialog for the sync frame's "delete hidden images" context
 * menu entry. Lists the files about to be deleted (first 10 names, then an
 * ellipsis) and only deletes them from the bound folder on confirm.
 */

import { useEffect, useState } from "react";

import { useI18n } from "@excalidraw/excalidraw/i18n";
import { useExcalidrawAPI } from "@excalidraw/excalidraw";

import { isImageElement } from "@excalidraw/element";

import { useAtom } from "../../app-jotai";
import { deleteHiddenImages } from "../frameActions";
import { deleteHiddenImagesTargetAtom } from "../state";

import type { LinkedFileMeta } from "../types";

const MAX_LISTED_NAMES = 10;

export const DeleteHiddenImagesDialog = () => {
  const { t } = useI18n();
  const excalidrawAPI = useExcalidrawAPI();
  const [frameId, setFrameId] = useAtom(deleteHiddenImagesTargetAtom);
  const [busy, setBusy] = useState(false);

  const names = frameId
    ? excalidrawAPI
        ?.getSceneElementsIncludingDeleted()
        .filter(
          (el) =>
            el.frameId === frameId &&
            el.isDeleted &&
            isImageElement(el) &&
            !!el.customData?.linkedFile,
        )
        .map(
          (el) => (el.customData!.linkedFile as LinkedFileMeta).displayName,
        ) ?? []
    : [];

  // close when there's nothing to delete (e.g. images were restored)
  useEffect(() => {
    if (frameId && !names.length) {
      setFrameId(null);
    }
  }, [frameId, names.length, setFrameId]);

  if (!frameId || !excalidrawAPI || !names.length) {
    return null;
  }

  const close = () => setFrameId(null);

  const confirm = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await deleteHiddenImages(excalidrawAPI, frameId);
      close();
    } finally {
      setBusy(false);
    }
  };

  const listed = names.slice(0, MAX_LISTED_NAMES);

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
        aria-label={t("linkedAssets.deleteHiddenTitle")}
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
        <div style={{ fontWeight: 600 }}>
          {t("linkedAssets.deleteHiddenTitle")}
        </div>
        <div style={{ fontSize: "0.875rem" }}>
          {t("linkedAssets.deleteHiddenMessage", { count: names.length })}
        </div>
        <ul
          style={{
            margin: 0,
            padding: "0 0 0 1.25rem",
            fontSize: "0.8125rem",
            opacity: 0.8,
            maxHeight: 200,
            overflowY: "auto",
          }}
        >
          {listed.map((name) => (
            <li key={name}>{name}</li>
          ))}
          {names.length > MAX_LISTED_NAMES && <li>…</li>}
        </ul>
        <div
          style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}
        >
          <button type="button" onClick={close}>
            {t("buttons.cancel")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void confirm()}
            style={{
              background: "var(--color-danger, #e03131)",
              color: "#fff",
              border: "none",
              borderRadius: "0.375rem",
              padding: "0.375rem 0.75rem",
              cursor: "pointer",
            }}
          >
            {t("buttons.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
};
