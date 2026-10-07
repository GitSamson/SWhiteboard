/**
 * Server-side video transcoding (HEVC/H.265 → H.264 mp4).
 *
 * Only works while the vite dev server is running (POST /api/transcode-video
 * is a dev-server middleware). When the API is unavailable (production static
 * hosting) the caller must fall back to the "unsupported codec" hint.
 */

import { newElementWith } from "@excalidraw/element";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { blobToDataURL } from "../linkedAssets/convert";

import type { VideoSourceFileMeta } from "./videoImport";

export interface TranscodeSourceFileMeta extends VideoSourceFileMeta {
  /** set once the scene BinaryFile holds the transcoded H.264 mp4 */
  transcoded?: boolean;
}

const HEVC_MIME_TYPES = new Set([
  "video/hevc",
  "video/hev1",
  "video/hvc1",
  "video/x-hevc",
  "video/x-h265",
]);

const HEVC_EXTENSIONS = [".hevc", ".h265"];

/** container-declared HEVC — covers files whose extension/MIME don't say so
 *  (e.g. iPhone .mov reports video/quicktime) only when the browser exposes a
 *  HEVC-specific MIME; otherwise playback failure is caught via the
 *  decodeFailed path */
export const isHevcByContainer = (file: {
  type: string;
  name: string;
}): boolean =>
  HEVC_MIME_TYPES.has(file.type.toLowerCase()) ||
  HEVC_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));

export const deviceSupportsHevc = (): boolean =>
  typeof document !== "undefined" &&
  document
    .createElement("video")
    .canPlayType('video/mp4; codecs="hev1.1.6.L120.90"') !== "";

export const transcodeVideoOnServer = async (
  blob: Blob,
  onProgress?: (sent: number, total: number) => void,
): Promise<Blob> => {
  const response = await fetch("/api/transcode-video", {
    method: "POST",
    headers: {
      "Content-Type": blob.type || "application/octet-stream",
    },
    body: blob,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `transcode failed with status ${response.status}`);
  }
  onProgress?.(blob.size, blob.size);
  return response.blob();
};

/** swap the scene BinaryFile for the transcoded mp4 and tag the embeddable */
export const replaceVideoWithTranscoded = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
  sourceFile: VideoSourceFileMeta,
  transcodedBlob: Blob,
  originalName: string,
): Promise<void> => {
  const dataURL = await blobToDataURL(transcodedBlob);
  const now = Date.now();
  excalidrawAPI.addFiles(
    [
      {
        id: sourceFile.fileId,
        mimeType: "video/mp4",
        dataURL,
        created: now,
        lastRetrieved: now,
      },
    ],
    { replace: true },
  );

  const mp4Name = `${originalName.replace(/\.[^.]+$/, "")}.mp4`;
  excalidrawAPI.updateScene({
    elements: excalidrawAPI.getSceneElementsIncludingDeleted().map((el) => {
      if (el.customData?.sourceFile?.fileId === sourceFile.fileId) {
        return newElementWith(el, {
          customData: {
            ...el.customData,
            sourceFile: { ...sourceFile, name: mp4Name, transcoded: true },
          },
        });
      }
      return el;
    }),
  });
};
