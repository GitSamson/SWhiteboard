/**
 * App-layer renderer for video embeddable elements (imported video files).
 * Mounted via the Excalidraw `renderEmbeddable` prop whenever an embeddable
 * has `customData.sourceFile.kind === "video"`.
 *
 * Plays the video from an object URL derived from the scene BinaryFiles
 * entry. The embeddable box resizes itself to the video's aspect ratio once
 * metadata loads. The capture-frame button (only while paused) renders in a
 * portal BELOW the video box (the overlay clips overflow, and inside the box
 * it covered the native controls) and inserts the current frame — with a
 * burned-in timecode — as an image element to the right of the video.
 * Unsupported codecs trigger an automatic server transcode (no manual click).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { newElementWith, newImageElement } from "@excalidraw/element";
import { generateIdFromFile } from "@excalidraw/excalidraw/data/blob";
import { useI18n } from "@excalidraw/excalidraw/i18n";
import Spinner from "@excalidraw/excalidraw/components/Spinner";

import type { AppState } from "@excalidraw/excalidraw/types";
import type { ExcalidrawEmbeddableElement } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { blobToDataURL } from "../linkedAssets/convert";

import { captureVideoFrame } from "./captureVideoFrame";
import { formatTimecode } from "./formatTimecode";
import {
  deviceSupportsHevc,
  isHevcByContainer,
  replaceVideoWithTranscoded,
  transcodeVideoOnServer,
} from "./transcode";

import type { TranscodeSourceFileMeta } from "./transcode";

/** scene-units gap between the video element and its captured frames */
const CAPTURE_OFFSET = 24;

const dataURLToBlob = (dataURL: string): Blob => {
  const [header, base64] = dataURL.split(",");
  const mime = header.match(/:(.*?);/)?.[1] ?? "application/octet-stream";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
};

export const VideoEmbed: React.FC<{
  element: ExcalidrawEmbeddableElement;
  appState: AppState;
  excalidrawAPI: ExcalidrawImperativeAPI;
}> = ({ element, appState, excalidrawAPI }) => {
  const { t } = useI18n();
  const sourceFile = element.customData?.sourceFile as
    | TranscodeSourceFileMeta
    | undefined;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [paused, setPaused] = useState(true);
  // NOTE: failure is DERIVED (below), not latched — these widgets mount while
  // the scene's BinaryFiles are still being restored from IndexedDB, and a
  // one-shot "no dataURL → failed" latch sticks even after the file arrives
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [transcoding, setTranscoding] = useState(false);
  /** set after a failed transcode so we never auto-retry in a loop */
  const [transcodeFailed, setTranscodeFailed] = useState(false);
  /** caps automatic re-transcodes (e.g. scenes where transcoded=true was
   *  persisted but the stored bytes are still the pre-transcode original) */
  const autoAttemptsRef = useRef(0);

  const dataURL = sourceFile?.fileId
    ? excalidrawAPI.getFiles()[sourceFile.fileId]?.dataURL
    : undefined;
  const fileMime = sourceFile?.fileId
    ? excalidrawAPI.getFiles()[sourceFile.fileId]?.mimeType
    : undefined;

  const startTranscode = async () => {
    if (!sourceFile?.fileId || !dataURL || transcoding) {
      return;
    }
    setTranscoding(true);
    try {
      const blob = dataURLToBlob(dataURL);
      const transcoded = await transcodeVideoOnServer(blob);
      await replaceVideoWithTranscoded(
        excalidrawAPI,
        sourceFile,
        transcoded,
        sourceFile.name,
      );
      setDecodeFailed(false);
    } catch (error) {
      console.error(error);
      setTranscodeFailed(true);
      excalidrawAPI.setToast({ message: t("mediaImport.loadError") });
    } finally {
      setTranscoding(false);
    }
  };

  // auto-transcode container-detected HEVC on devices that can't decode it
  useEffect(() => {
    if (
      sourceFile &&
      !sourceFile.transcoded &&
      !transcodeFailed &&
      !deviceSupportsHevc() &&
      isHevcByContainer({ type: fileMime ?? "", name: sourceFile.name })
    ) {
      void startTranscode();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per source file / dataURL swap
  }, [sourceFile?.fileId, sourceFile?.transcoded, dataURL]);

  // codec the browser can't decode → transcode right away, no manual click.
  // Note: don't gate on sourceFile.transcoded — scenes saved mid-transcode
  // can carry transcoded=true while the stored bytes are still the original
  // codec; the only source of truth is whether playback fails.
  useEffect(() => {
    if (
      decodeFailed &&
      sourceFile?.fileId &&
      !transcoding &&
      autoAttemptsRef.current < 2
    ) {
      autoAttemptsRef.current += 1;
      void startTranscode();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- attempt cap guards the loop
  }, [decodeFailed, sourceFile?.fileId]);

  /** resize the embeddable to the video's aspect once metadata is known */
  const onLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video?.videoWidth) {
      return;
    }
    const expectedHeight = Math.round(
      element.width * (video.videoHeight / video.videoWidth),
    );
    if (Math.abs(element.height - expectedHeight) > 1) {
      excalidrawAPI.updateScene({
        elements: excalidrawAPI
          .getSceneElements()
          .map((el) =>
            el.id === element.id
              ? newElementWith(el, { height: expectedHeight })
              : el,
          ),
      });
    }
  };

  const blobUrl = useMemo(() => {
    if (!dataURL) {
      return null;
    }
    try {
      return URL.createObjectURL(dataURLToBlob(dataURL));
    } catch (error) {
      return null;
    }
  }, [dataURL]);

  useEffect(
    () => () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    },
    [blobUrl],
  );

  // missing file is only an error once the scene has finished restoring —
  // while `isLoading` is set the BinaryFiles haven't been added yet
  const failed = !dataURL && !appState.isLoading;

  const captureFrame = async () => {
    const video = videoRef.current;
    if (!video || !paused || busy || !sourceFile?.fileId) {
      return;
    }
    setBusy(true);
    try {
      const timecode = formatTimecode(video.currentTime);
      const blob = await captureVideoFrame(video, timecode);
      const fileId = await generateIdFromFile(
        new File([blob], `frame-${timecode.replaceAll(":", "-")}.jpg`, {
          type: "image/jpeg",
        }),
      );
      excalidrawAPI.addFiles([
        {
          mimeType: "image/jpeg",
          id: fileId,
          dataURL: await blobToDataURL(blob),
          created: Date.now(),
          lastRetrieved: Date.now(),
        },
      ]);
      const image = newImageElement({
        type: "image",
        x: element.x + element.width + CAPTURE_OFFSET,
        y: element.y,
        width: element.width,
        height: element.height,
        fileId,
        status: "saved",
        customData: {
          timecode,
          sourceVideo: { fileId: sourceFile.fileId },
        },
      });
      excalidrawAPI.updateScene({
        elements: [...excalidrawAPI.getSceneElements(), image],
        appState: { selectedElementIds: { [image.id]: true } },
      });
    } finally {
      setBusy(false);
    }
  };

  const videoBox = (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        background: "#000",
      }}
    >
      {transcoding ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            color: "#fff",
            fontSize: 13,
          }}
        >
          <Spinner size={28} />
          {t("mediaImport.transcoding")}
        </div>
      ) : failed || decodeFailed ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            color: "#fff",
            fontSize: 13,
            padding: "0 12px",
            textAlign: "center",
          }}
        >
          <div>
            {decodeFailed
              ? t("mediaImport.videoUnsupported")
              : t("mediaImport.loadError")}
          </div>
          {decodeFailed && (
            <button
              type="button"
              disabled={transcoding}
              onClick={() => {
                setTranscodeFailed(false);
                void startTranscode();
              }}
              style={{
                background: "rgba(0, 0, 0, 0.75)",
                border: "1px solid rgba(255, 255, 255, 0.4)",
                borderRadius: 4,
                color: "#fff",
                cursor: "pointer",
                fontSize: 12,
                padding: "2px 10px",
              }}
            >
              {t("mediaImport.transcodeButton")}
            </button>
          )}
        </div>
      ) : (
        <video
          ref={videoRef}
          controls
          src={blobUrl ?? undefined}
          onPlay={() => setPaused(false)}
          onPause={() => setPaused(true)}
          onError={() => setDecodeFailed(true)}
          onLoadedMetadata={onLoadedMetadata}
          style={{
            width: "100%",
            height: "100%",
            background: "#000",
            objectFit: "contain",
          }}
        />
      )}
    </div>
  );

  // capture button lives BELOW the video box (portal): inside the box it
  // covered the native controls, and the embeddable overlay clips overflow
  const zoom = appState.zoom.value;
  const captureEnabled =
    paused && !busy && !failed && !decodeFailed && !transcoding;
  const captureButton = createPortal(
    <button
      type="button"
      disabled={!captureEnabled}
      onClick={() => void captureFrame()}
      title={t("mediaImport.captureFrame")}
      style={{
        position: "absolute",
        left:
          (element.x + appState.scrollX) * zoom + (element.width * zoom) / 2,
        transform: "translateX(-50%)",
        top: (element.y + appState.scrollY + element.height) * zoom + 4,
        background: "rgba(0, 0, 0, 0.75)",
        border: "1px solid rgba(255, 255, 255, 0.4)",
        borderRadius: 4,
        color: "#fff",
        cursor: captureEnabled ? "pointer" : "default",
        fontSize: 12,
        opacity: captureEnabled ? 1 : 0.5,
        padding: "3px 10px",
        zIndex: 5,
        whiteSpace: "nowrap",
      }}
    >
      {t("mediaImport.captureFrame")}
    </button>,
    document.body,
  );

  return (
    <>
      {videoBox}
      {captureButton}
    </>
  );
};
