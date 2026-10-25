/**
 * Unit tests for paste-to-replace (fill-crop) geometry.
 */

import { describe, expect, it } from "vitest";

import { centerFillCrop } from "../media/pasteReplaceImage";

describe("centerFillCrop", () => {
  it("crops left/right when the source is wider than the target box", () => {
    // source 400x200 (2:1) into a 1:1 box → crop to 200x200 centered
    expect(centerFillCrop(400, 200, 1)).toEqual({
      x: 100,
      y: 0,
      width: 200,
      height: 200,
      naturalWidth: 400,
      naturalHeight: 200,
    });
  });

  it("crops top/bottom when the source is taller than the target box", () => {
    // source 256x256 (1:1) into a 3:2 box → height = 256 * 2/3
    const crop = centerFillCrop(256, 256, 1.5);
    expect(crop.width).toBe(256);
    expect(crop.height).toBeCloseTo(256 / 1.5, 6);
    expect(crop.x).toBe(0);
    expect(crop.y).toBeCloseTo((256 - 256 / 1.5) / 2, 6);
    expect(crop.naturalWidth).toBe(256);
    expect(crop.naturalHeight).toBe(256);
  });

  it("keeps the whole image when aspects already match", () => {
    expect(centerFillCrop(300, 200, 1.5)).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      naturalWidth: 300,
      naturalHeight: 200,
    });
  });
});
