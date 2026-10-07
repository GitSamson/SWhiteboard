/**
 * Unit tests for the media import (PDF / video) app-layer helpers.
 *
 * The excalidraw API is faked in-memory and fetch/pdf-open/pdf-page are
 * mocked; component tests (PdfToolbarHost / VideoEmbed) are skipped on
 * purpose — jsdom cannot render canvas/video and the meaningful logic
 * (page keys, page turns, fetch helpers, page range clamping, insert
 * geometry, frame capture) is covered via the helpers below.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CaptureUpdateAction,
  newPdfElement,
  pdfPageKey,
} from "@excalidraw/element";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { formatTimecode } from "../video/formatTimecode";
import { burnTimecode, captureVideoFrame } from "../video/captureVideoFrame";
import {
  isHevcByContainer,
  replaceVideoWithTranscoded,
  transcodeVideoOnServer,
} from "../video/transcode";
import { buildFfmpegArgs } from "../viteTranscodePlugin";
import { clampPageRange } from "../pdf/pageRange";
import { fetchPdfPage, openPdfData } from "../pdf/pdfPageCache";
import { turnPdfPage } from "../pdf/pdfNavigation";
import {
  insertPageImages,
  PAGE_IMAGE_GAP,
  PAGE_IMAGE_WIDTH,
} from "../pdf/pdfPages";

// ---------------------------------------------------------------------------
// module mocks
// ---------------------------------------------------------------------------

vi.mock("../pdf/imageDims", () => ({
  getImageBlobDimensions: vi.fn(async (blob: any) => blob.__dims),
}));

vi.mock("../linkedAssets/convert", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../linkedAssets/convert")
  >();
  return {
    ...original,
    blobToDataURL: vi.fn(async () => "data:video/mp4;base64,dHJhbnNjb2RlZA=="),
  };
});

vi.mock("@excalidraw/excalidraw/data/blob", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@excalidraw/excalidraw/data/blob")
  >();
  return {
    ...original,
    generateIdFromFile: vi.fn(async (file: File) => `hash-${file.name}`),
  };
});

const fakeAPI = () => {
  const state = { elements: [] as any[] };
  return {
    api: {
      addFiles: vi.fn(),
      updateScene: vi.fn((data: any) => {
        if (data.elements) {
          state.elements = data.elements;
        }
      }),
      getSceneElements: () => state.elements,
      getSceneElementsIncludingDeleted: () => state.elements,
      setToast: vi.fn(),
      getFiles: () => ({}),
    } as unknown as ExcalidrawImperativeAPI,
    state,
  };
};

const pageBlob = (dims: { width: number; height: number }) => {
  const blob = new Blob(["x"], { type: "image/jpeg" });
  (blob as any).__dims = dims;
  return blob;
};

// ---------------------------------------------------------------------------
// formatTimecode
// ---------------------------------------------------------------------------

describe("formatTimecode", () => {
  it("formats zero", () => {
    expect(formatTimecode(0)).toBe("00:00:00");
  });

  it("formats 3661s as 01:01:01", () => {
    expect(formatTimecode(3661)).toBe("01:01:01");
  });

  it("truncates fractional seconds", () => {
    expect(formatTimecode(59.9)).toBe("00:00:59");
    expect(formatTimecode(3661.75)).toBe("01:01:01");
  });

  it("clamps negative values to zero", () => {
    expect(formatTimecode(-5)).toBe("00:00:00");
  });
});

// ---------------------------------------------------------------------------
// clampPageRange
// ---------------------------------------------------------------------------

describe("clampPageRange", () => {
  it("keeps a valid range", () => {
    expect(clampPageRange(2, 5, 10)).toEqual({ start: 2, end: 5 });
  });

  it("clamps into [1, pageCount]", () => {
    expect(clampPageRange(0, 99, 10)).toEqual({ start: 1, end: 10 });
  });

  it("coerces to integers", () => {
    expect(clampPageRange(1.9, 3.2, 10)).toEqual({ start: 1, end: 3 });
  });

  it("collapses end < start to the start page", () => {
    expect(clampPageRange(5, 2, 10)).toEqual({ start: 5, end: 5 });
  });
});

// ---------------------------------------------------------------------------
// pdf page keys
// ---------------------------------------------------------------------------

describe("pdfPageKey", () => {
  it("joins fileId and page", () => {
    expect(pdfPageKey("abc", 3)).toBe("abc:3");
  });
});

// ---------------------------------------------------------------------------
// turnPdfPage
// ---------------------------------------------------------------------------

describe("turnPdfPage", () => {
  const pdfElement = (currentPage = 1, pageCount = 5) =>
    newPdfElement({
      type: "pdf",
      x: 10,
      y: 20,
      width: 480,
      height: 640,
      customData: {
        sourceFile: {
          fileId: "fid" as any,
          kind: "pdf",
          name: "d.pdf",
          pageCount,
          currentPage,
        },
      },
    });

  it("updates currentPage via newElementWith without capturing an undo step", () => {
    const { api, state } = fakeAPI();
    const element = pdfElement(1, 5);
    state.elements = [element, { id: "other" } as any];

    turnPdfPage(api, element, 3);

    expect(api.updateScene).toHaveBeenCalledTimes(1);
    const update = (api.updateScene as any).mock.calls[0][0];
    expect(update.captureUpdate).toBe(CaptureUpdateAction.NEVER);
    const updated = update.elements.find((el: any) => el.id === element.id);
    expect(updated).not.toBe(element);
    expect(updated.customData.sourceFile.currentPage).toBe(3);
    expect(element.customData!.sourceFile.currentPage).toBe(1);
    expect(update.elements.find((el: any) => el.id === "other")).toEqual({
      id: "other",
    });
  });

  it("clamps into [1, pageCount] and no-ops when the page doesn't change", () => {
    const { api, state } = fakeAPI();
    const element = pdfElement(3, 5);
    state.elements = [element];

    turnPdfPage(api, element, 99);
    const update = (api.updateScene as any).mock.calls[0][0];
    const updatedElement = update.elements[0];
    expect(updatedElement.customData.sourceFile.currentPage).toBe(5);

    (api.updateScene as any).mockClear();
    turnPdfPage(api, updatedElement, 5);
    expect(api.updateScene).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// fetchPdfPage / openPdfData
// ---------------------------------------------------------------------------

describe("fetchPdfPage", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds the query URL and resolves the webp blob", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob(["webp"], { type: "image/webp" }),
    })) as any;
    vi.stubGlobal("fetch", fetchMock);

    const blob = await fetchPdfPage("deadbeef", 2, 1440);

    expect(blob.type).toBe("image/webp");
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/pdf-page?hash=deadbeef&page=2&width=1440");
  });

  it("defaults the width to 1200 and propagates server errors", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => "unknown hash",
    })) as any;
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPdfPage("abc", 1)).rejects.toThrow("unknown hash");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/pdf-page?hash=abc&page=1&width=1200",
    );
  });
});

describe("openPdfData", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the bytes to /api/pdf-open and caches the info per dataURL", async () => {
    const info = {
      hash: "h1",
      pageCount: 2,
      pages: [{ width: 595, height: 842 }],
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("data:")) {
        return {
          ok: true,
          arrayBuffer: async () => new TextEncoder().encode("pdfbytes").buffer,
        } as any;
      }
      return { ok: true, status: 200, json: async () => info } as any;
    }) as any;
    vi.stubGlobal("fetch", fetchMock);

    const dataURL = "data:application/pdf;base64,AAAA-1";
    const first = await openPdfData(dataURL);
    const second = await openPdfData(dataURL);

    expect(first).toEqual(info);
    expect(second).toBe(first);
    // one dataURL fetch + one pdf-open POST — the second call is fully cached
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/pdf-open");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("propagates server error text", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith("data:")
        ? ({
            ok: true,
            arrayBuffer: async () => new Uint8Array().buffer,
          } as any)
        : ({ ok: false, status: 500, text: async () => "boom" } as any),
    ) as any;
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      openPdfData("data:application/pdf;base64,BBBB-2"),
    ).rejects.toThrow("boom");
  });
});

// ---------------------------------------------------------------------------
// insertPageImages geometry
// ---------------------------------------------------------------------------

describe("insertPageImages", () => {
  it("lays page images out in a vertical column and tags customData", async () => {
    const { api } = fakeAPI();
    const insertAt = { x: 100, y: 200 };

    const elements = await insertPageImages(
      [
        { blob: pageBlob({ width: 1440, height: 2880 }), pageNumber: 1 },
        { blob: pageBlob({ width: 1440, height: 2160 }), pageNumber: 2 },
      ],
      insertAt,
      api,
      "source-pdf-id" as any,
    );

    expect(elements).toHaveLength(2);
    const [first, second] = elements;

    expect(first.type).toBe("image");
    expect(first.width).toBe(PAGE_IMAGE_WIDTH);
    expect(first.height).toBe(1440); // 720 * 2880/1440
    expect(first.x).toBe(insertAt.x);
    expect(first.y).toBe(insertAt.y);
    expect(first.status).toBe("saved");
    expect(first.fileId).toBe("hash-pdf-page-1.jpg");
    expect(first.customData).toEqual({
      sourcePdf: { fileId: "source-pdf-id", page: 1 },
    });

    expect(second.width).toBe(PAGE_IMAGE_WIDTH);
    expect(second.height).toBe(1080); // 720 * 2160/1440
    expect(second.y).toBe(insertAt.y + 1440 + PAGE_IMAGE_GAP);
    expect(second.customData).toEqual({
      sourcePdf: { fileId: "source-pdf-id", page: 2 },
    });

    expect(api.addFiles).toHaveBeenCalledTimes(1);
    const files = (api.addFiles as any).mock.calls[0][0];
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      mimeType: "image/jpeg",
      id: "hash-pdf-page-1.jpg",
    });

    expect(api.updateScene).toHaveBeenCalledTimes(1);
    const sceneUpdate = (api.updateScene as any).mock.calls[0][0];
    expect(sceneUpdate.elements).toHaveLength(2);
    expect(sceneUpdate.appState.selectedElementIds).toEqual({
      [first.id]: true,
      [second.id]: true,
    });
  });

  it("appends to existing scene elements", async () => {
    const { api, state } = fakeAPI();
    state.elements = [{ id: "existing" } as any];

    await insertPageImages(
      [{ blob: pageBlob({ width: 720, height: 720 }), pageNumber: 3 }],
      { x: 0, y: 0 },
      api,
      "source" as any,
    );

    const sceneUpdate = (api.updateScene as any).mock.calls[0][0];
    expect(sceneUpdate.elements[0]).toEqual({ id: "existing" });
    expect(sceneUpdate.elements).toHaveLength(2);
  });

  it("follows the blob mime for webp pages coming from the server", async () => {
    const { api } = fakeAPI();
    const blob = new Blob(["x"], { type: "image/webp" });
    (blob as any).__dims = { width: 1600, height: 800 };

    const [element] = await insertPageImages(
      [{ blob, pageNumber: 1 }],
      { x: 0, y: 0 },
      api,
      "source" as any,
    );

    expect(element.fileId).toBe("hash-pdf-page-1.webp");
    const files = (api.addFiles as any).mock.calls[0][0];
    expect(files[0]).toMatchObject({
      mimeType: "image/webp",
      id: "hash-pdf-page-1.webp",
    });
  });
});

// ---------------------------------------------------------------------------
// captureVideoFrame
// ---------------------------------------------------------------------------

describe("captureVideoFrame", () => {
  const fakeCanvas = () => {
    const context = {
      drawImage: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      measureText: vi.fn(() => ({ width: 120 })),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      font: "",
      fillStyle: "",
      textBaseline: "top",
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
      toBlob: vi.fn((callback: (blob: Blob | null) => void) =>
        callback(new Blob(["frame"], { type: "image/jpeg" })),
      ),
    };
    return { canvas, context };
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("draws the frame at native resolution, burns the timecode, encodes JPEG", async () => {
    const { canvas, context } = fakeCanvas();
    const createElementSpy = vi
      .spyOn(document, "createElement")
      .mockReturnValue(canvas as any);
    const video = { videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement;

    const blob = await captureVideoFrame(video, "00:01:05");

    expect(createElementSpy).toHaveBeenCalledWith("canvas");
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
    expect(context.drawImage).toHaveBeenCalledTimes(1);
    expect(context.drawImage).toHaveBeenCalledWith(video, 0, 0, 1920, 1080);
    expect(context.fillText).toHaveBeenCalledTimes(1);
    expect(context.fillText).toHaveBeenCalledWith(
      "00:01:05",
      expect.any(Number),
      expect.any(Number),
    );
    expect(canvas.toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      "image/jpeg",
      0.92,
    );
    expect(blob.type).toBe("image/jpeg");
  });
});

describe("burnTimecode", () => {
  it("draws a black label with white text in the top-right corner", () => {
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      measureText: vi.fn(() => ({ width: 120 })),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      font: "",
      fillStyle: "",
      textBaseline: "top",
    } as unknown as CanvasRenderingContext2D;

    burnTimecode(context, 1920, 1080, "00:00:10");

    // font size = height / 20 = 54
    expect(context.font).toBe("54px monospace");
    expect(context.measureText).toHaveBeenCalledTimes(1);
    expect(context.fillRect).toHaveBeenCalledTimes(1);
    expect(context.fillText).toHaveBeenCalledTimes(1);
    expect(context.fillStyle).toBe("#fff");
    const [text, x, y] = (context.fillText as any).mock.calls[0];
    expect(text).toBe("00:00:10");
    // top-right: text x is beyond the canvas midpoint
    expect(x).toBeGreaterThan(960);
    expect(y).toBe(8); // padding 4 * 2
    expect(context.save).toHaveBeenCalledTimes(1);
    expect(context.restore).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// transcode (HEVC → H.264 via dev-server middleware)
// ---------------------------------------------------------------------------

describe("isHevcByContainer", () => {
  it("matches HEVC-specific MIME types", () => {
    for (const type of [
      "video/hevc",
      "video/hev1",
      "video/hvc1",
      "video/x-hevc",
      "video/x-h265",
    ]) {
      expect(isHevcByContainer({ type, name: "clip.mp4" })).toBe(true);
    }
  });

  it("matches .hevc / .h265 extensions regardless of MIME", () => {
    expect(isHevcByContainer({ type: "", name: "clip.hevc" })).toBe(true);
    expect(isHevcByContainer({ type: "", name: "CLIP.H265" })).toBe(true);
    expect(
      isHevcByContainer({ type: "video/quicktime", name: "clip.h265" }),
    ).toBe(true);
  });

  it("rejects other videos (incl. HEVC-in-.mov with generic MIME)", () => {
    expect(isHevcByContainer({ type: "video/mp4", name: "clip.mp4" })).toBe(
      false,
    );
    expect(
      isHevcByContainer({ type: "video/quicktime", name: "iphone.mov" }),
    ).toBe(false);
    expect(isHevcByContainer({ type: "video/webm", name: "clip.mkv" })).toBe(
      false,
    );
  });
});

describe("replaceVideoWithTranscoded", () => {
  it("replaces the BinaryFile and tags the embeddable customData", async () => {
    const element = {
      id: "el-1",
      customData: {
        sourceFile: { fileId: "file-1", kind: "video", name: "clip.hevc" },
      },
    };
    const { api, state } = fakeAPI();
    state.elements = [element, { id: "el-2", customData: {} }];

    await replaceVideoWithTranscoded(
      api,
      element.customData.sourceFile as any,
      new Blob(["mp4"], { type: "video/mp4" }),
      "clip.hevc",
    );

    expect(api.addFiles).toHaveBeenCalledTimes(1);
    const [files, options] = (api.addFiles as any).mock.calls[0];
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      id: "file-1",
      mimeType: "video/mp4",
      dataURL: "data:video/mp4;base64,dHJhbnNjb2RlZA==",
    });
    expect(files[0].created).toBeGreaterThan(0);
    expect(files[0].lastRetrieved).toBeGreaterThan(0);
    expect(options).toEqual({ replace: true });

    expect(api.updateScene).toHaveBeenCalledTimes(1);
    const update = (api.updateScene as any).mock.calls[0][0];
    const updated = update.elements.find((el: any) => el.id === "el-1");
    expect(updated.customData.sourceFile).toEqual({
      fileId: "file-1",
      kind: "video",
      name: "clip.mp4",
      transcoded: true,
    });
    expect(updated).not.toBe(element);
    const untouched = update.elements.find((el: any) => el.id === "el-2");
    expect(untouched).toEqual({ id: "el-2", customData: {} });
  });
});

describe("transcodeVideoOnServer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs the raw bytes and resolves the mp4 blob", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
      const blob = new Blob(["mp4"], { type: "video/mp4" });
      return { ok: true, status: 200, blob: async () => blob } as any;
    });
    vi.stubGlobal("fetch", fetchMock);

    const body = new Blob(["hevc"], { type: "video/hevc" });
    const onProgress = vi.fn();
    const result = await transcodeVideoOnServer(body, onProgress);

    expect(result.type).toBe("video/mp4");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/transcode-video");
    const requestInit = init as RequestInit;
    expect(requestInit.method).toBe("POST");
    expect(
      (requestInit.headers as Record<string, string>)["Content-Type"],
    ).toBe("video/hevc");
    expect(requestInit.body).toBe(body);
    expect(onProgress).toHaveBeenCalledWith(4, 4);
  });

  it("falls back to application/octet-stream when the blob has no type", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
      const blob = new Blob(["mp4"], { type: "video/mp4" });
      return { ok: true, status: 200, blob: async () => blob } as any;
    });
    vi.stubGlobal("fetch", fetchMock);

    await transcodeVideoOnServer(new Blob(["x"]));

    const call = fetchMock.mock.calls[0];
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/octet-stream");
  });

  it("propagates the server error text on failure", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "ffmpeg exploded",
    })) as any;
    vi.stubGlobal("fetch", fetchMock);

    await expect(transcodeVideoOnServer(new Blob(["x"]))).rejects.toThrow(
      "ffmpeg exploded",
    );
  });
});

describe("buildFfmpegArgs", () => {
  it("assembles the H.264 transcode with capped scale", () => {
    expect(buildFfmpegArgs("in.bin", "out.mp4")).toEqual([
      "-y",
      "-i",
      "in.bin",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-vf",
      "scale='min(1920,iw)':-2",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      "out.mp4",
    ]);
  });

  it("drops the scale filter on fallback", () => {
    const args = buildFfmpegArgs("in.bin", "out.mp4", false);
    expect(args).not.toContain("-vf");
    expect(args.join(" ")).not.toContain("scale");
    expect(args[args.length - 1]).toBe("out.mp4");
  });
});
