/**
 * Unit tests for the asset-type registry (linked file assets): the import
 * filter must match the previous hardcoded image-extension list exactly,
 * and unimplemented placeholder types (video/pdf) must stay excluded.
 */

import { describe, expect, it } from "vitest";

import {
  getAssetTypeHandler,
  isImportableAssetFile,
  isPlaceholderAssetFile,
  listAssetTypeHandlers,
} from "../linkedAssets/assetTypes";

describe("assetTypes registry", () => {
  it("registers image (implemented) plus video/pdf placeholders", () => {
    const handlers = listAssetTypeHandlers();
    expect(handlers.map((h) => h.id)).toEqual(["image", "video", "pdf"]);
    expect(getAssetTypeHandler("png")?.implemented).toBe(true);
    expect(getAssetTypeHandler("mp4")?.implemented).toBe(false);
    expect(getAssetTypeHandler("pdf")?.implemented).toBe(false);
  });

  it("imports exactly the legacy image extension set, case-insensitive", () => {
    const legacyPattern = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|jfif)$/i;
    const names = [
      "a.png",
      "b.JPG",
      "c.jpeg",
      "d.gif",
      "e.webp",
      "f.svg",
      "g.bmp",
      "h.ico",
      "i.avif",
      "j.jfif",
      "k.txt",
      "l.mp4",
      "m.pdf",
      "n",
      "o.png.txt",
      ".png",
    ];
    for (const name of names) {
      expect(isImportableAssetFile({ name })).toBe(legacyPattern.test(name));
    }
  });

  it("rejects extension/mime mismatches when a mimeType is known", () => {
    expect(
      isImportableAssetFile({ name: "evil.png", mimeType: "application/pdf" }),
    ).toBe(false);
    expect(
      isImportableAssetFile({ name: "ok.png", mimeType: "image/png" }),
    ).toBe(true);
  });

  it("flags unknown formats as placeholder candidates, excluding dotfiles", () => {
    // unknown formats → placeholder
    expect(isPlaceholderAssetFile({ name: "notes.txt" })).toBe(true);
    expect(isPlaceholderAssetFile({ name: "archive.zip" })).toBe(true);
    expect(isPlaceholderAssetFile({ name: "Makefile" })).toBe(true);
    // declared-but-unimplemented types are placeholders too
    expect(isPlaceholderAssetFile({ name: "clip.mp4" })).toBe(true);
    expect(isPlaceholderAssetFile({ name: "doc.pdf" })).toBe(true);
    // mime mismatch on an image extension is NOT a real image → placeholder
    expect(
      isPlaceholderAssetFile({ name: "evil.png", mimeType: "application/pdf" }),
    ).toBe(true);
    // importable images and dotfiles are not placeholders
    expect(isPlaceholderAssetFile({ name: "ok.png" })).toBe(false);
    expect(
      isPlaceholderAssetFile({ name: "ok.png", mimeType: "image/png" }),
    ).toBe(false);
    expect(isPlaceholderAssetFile({ name: ".DS_Store" })).toBe(false);
    expect(isPlaceholderAssetFile({ name: ".png" })).toBe(false);
    expect(isPlaceholderAssetFile({ name: "" })).toBe(false);
  });
});
