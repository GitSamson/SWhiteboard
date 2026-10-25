/**
 * File-icon placeholders for the "linked file assets" feature: files in a
 * sync folder whose format the app can't import (documents, archives,
 * design files…) still appear on the board as an image element whose
 * BinaryFiles entry is a generated icon — a document glyph with a colored
 * extension band. The icon never contains the file NAME (renames would
 * stale it); the extension band stays correct because renames preserve the
 * extension.
 *
 * Canvas access is isolated in `generateFilePlaceholder` so tests running
 * in jsdom (no canvas 2d implementation) can mock the module.
 */

import type { DataURL } from "@excalidraw/excalidraw/types";

/** natural size of generated placeholder icons, in px */
export const FILE_PLACEHOLDER_WIDTH = 240;
export const FILE_PLACEHOLDER_HEIGHT = 300;

const PLACEHOLDER_MIME_TYPE = "image/webp";
const PLACEHOLDER_QUALITY = 0.9;

/** uppercased extension shown on the icon band ("TXT", "PSD"…), else "FILE" */
export const getFileExtensionLabel = (name: string): string => {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) {
    return "FILE";
  }
  const extension = base.slice(dot + 1).toUpperCase();
  return extension.length >= 1 && extension.length <= 6 ? extension : "FILE";
};

/** deterministic band color per extension so types are visually distinct */
const hueForLabel = (label: string): number => {
  let hash = 7;
  for (const char of label) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }
  return hash;
};

const roundedRectPath = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void => {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.arcTo(x + width, y, x + width, y + r, r);
  context.lineTo(x + width, y + height - r);
  context.arcTo(x + width, y + height, x + width - r, y + height, r);
  context.lineTo(x + r, y + height);
  context.arcTo(x, y + height, x, y + height - r, r);
  context.lineTo(x, y + r);
  context.arcTo(x, y, x + r, y, r);
  context.closePath();
};

/** outline of a document page with the top-right corner folded away */
const documentPath = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  fold: number,
  radius: number,
): void => {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - fold, y);
  context.lineTo(x + width, y + fold);
  context.lineTo(x + width, y + height - radius);
  context.arcTo(x + width, y + height, x + width - radius, y + height, radius);
  context.lineTo(x + radius, y + height);
  context.arcTo(x, y + height, x, y + height - radius, radius);
  context.lineTo(x, y + radius);
  context.arcTo(x, y, x + radius, y, radius);
  context.closePath();
};

/**
 * Draws the file-icon for `name` and returns it as a webp dataURL plus the
 * icon's natural dimensions. Pure generation — nothing touches the disk.
 */
export const generateFilePlaceholder = (
  name: string,
  opts: { doc?: Document } = {},
): { dataURL: DataURL; width: number; height: number } => {
  const doc = opts.doc ?? document;
  const width = FILE_PLACEHOLDER_WIDTH;
  const height = FILE_PLACEHOLDER_HEIGHT;
  const canvas = doc.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D context is not available");
  }

  const label = getFileExtensionLabel(name);
  const hue = hueForLabel(label);

  const x = 14;
  const y = 10;
  const w = width - 28;
  const h = height - 24;
  const fold = 48;
  const radius = 18;

  // drop shadow
  roundedRectPath(context, x + 3, y + 6, w, h, radius);
  context.fillStyle = "rgba(15, 23, 42, 0.14)";
  context.fill();

  // page body
  documentPath(context, x, y, w, h, fold, radius);
  context.fillStyle = "#f8fafc";
  context.fill();
  context.lineWidth = 3;
  context.strokeStyle = "#cbd5e1";
  context.stroke();

  // folded corner
  context.beginPath();
  context.moveTo(x + w - fold, y);
  context.lineTo(x + w, y + fold);
  context.lineTo(x + w - fold, y + fold);
  context.closePath();
  context.fillStyle = "#e2e8f0";
  context.fill();

  // "text lines" decoration
  context.fillStyle = "#e2e8f0";
  const lineWidths = [0.62, 0.5, 0.58];
  lineWidths.forEach((share, index) => {
    roundedRectPath(
      context,
      x + 26,
      y + 62 + index * 26,
      (w - 52) * share,
      11,
      5.5,
    );
    context.fill();
  });

  // extension band, clipped to the page outline so the bottom corners
  // stay rounded
  const bandHeight = 74;
  context.save();
  documentPath(context, x, y, w, h, fold, radius);
  context.clip();
  context.fillStyle = `hsl(${hue} 55% 52%)`;
  context.fillRect(x, y + h - bandHeight, w, bandHeight);
  context.restore();

  // extension label
  context.fillStyle = "#ffffff";
  context.font = `bold ${Math.round(
    bandHeight * 0.42,
  )}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, x + w / 2, y + h - bandHeight / 2 + 2);

  return {
    dataURL: canvas.toDataURL(
      PLACEHOLDER_MIME_TYPE,
      PLACEHOLDER_QUALITY,
    ) as DataURL,
    width,
    height,
  };
};
