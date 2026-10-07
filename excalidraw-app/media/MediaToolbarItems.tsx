/**
 * "Import PDF" / "Import video" buttons for the main toolbar island
 * (injected via the library's `renderCustomToolbarItems` prop, next to the
 * image tool). Inline SVG icons — the library's icon set has no pdf/video
 * glyphs.
 */

import React from "react";

import { useI18n } from "@excalidraw/excalidraw/i18n";

const buttonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "1.5rem",
  height: "1.5rem",
  padding: 0,
  border: "none",
  background: "none",
  color: "var(--color-icon-primary, #1b1b1f)",
  cursor: "pointer",
  borderRadius: "0.25rem",
};

const PdfIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M8 17h8M8 13h8" />
  </svg>
);

const VideoIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="2" y="5" width="14" height="14" rx="2" />
    <path d="M16 10l6-3v10l-6-3" />
  </svg>
);

export const MediaToolbarItems: React.FC<{
  onImportPdf: () => void;
  onImportVideo: () => void;
}> = ({ onImportPdf, onImportVideo }) => {
  const { t } = useI18n();
  return (
    <>
      <button
        type="button"
        className="media-toolbar-button"
        style={buttonStyle}
        title={t("mediaImport.importPdf")}
        aria-label={t("mediaImport.importPdf")}
        onClick={onImportPdf}
      >
        <PdfIcon />
      </button>
      <button
        type="button"
        className="media-toolbar-button"
        style={buttonStyle}
        title={t("mediaImport.importVideo")}
        aria-label={t("mediaImport.importVideo")}
        onClick={onImportVideo}
      >
        <VideoIcon />
      </button>
    </>
  );
};
