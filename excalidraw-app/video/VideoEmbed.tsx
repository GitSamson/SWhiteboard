/**
 * App-layer renderer for video embeddable elements (imported video files).
 * Mounted via the Excalidraw `renderEmbeddable` prop whenever an embeddable
 * has `customData.sourceFile.kind === "video"`.
 *
 * Plays the video from an object URL derived from the scene BinaryFiles
 * entry. The embeddable box resizes itself to the video's aspect ratio once
 * metadata loads. The native `<video controls>` are replaced by two
 * selection-gated portals (the overlay clips overflow, and inside the box
 * they covered the video):
 * - ABOVE the box: the shared floating icon toolbar (`media/ElementToolbar`)
 *   — node info (name / pixel size / file size), download source, replace
 *   video, capture frame (enabled only while paused), fullscreen.
 * - BELOW the box: custom playback controls (`VideoControlsBar`) —
 *   play/pause, seek bar, volume/mute, capture frame.
 * Unsupported codecs trigger an automatic server transcode (no manual click).
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { newElementWith, newImageElement } from "@excalidraw/element";
import { generateIdFromFile } from "@excalidraw/excalidraw/data/blob";
import { useI18n } from "@excalidraw/excalidraw/i18n";
import Spinner from "@excalidraw/excalidraw/components/Spinner";

import type { AppState } from "@excalidraw/excalidraw/types";
import type { ExcalidrawEmbeddableElement } from "@excalidraw/element/types";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { blobToDataURL } from "../linkedAssets/convert";
import {
  ElementToolbar,
  ToolbarIconButton,
  ToolbarPopover,
} from "../media/ElementToolbar";
import { pickFile } from "../media/filePicker";
import {
  ToolbarCameraIcon,
  ToolbarDownloadIcon,
  ToolbarFullscreenIcon,
  ToolbarInfoIcon,
  ToolbarReplaceIcon,
} from "../media/toolbarIcons";

import { captureVideoFrame } from "./captureVideoFrame";
import { formatTimecode } from "./formatTimecode";
import {
  deviceSupportsHevc,
  isHevcByContainer,
  replaceVideoWithTranscoded,
  transcodeVideoOnServer,
} from "./transcode";
import { VideoControlsBar } from "./VideoControlsBar";

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

/** approximate decoded byte size of a base64 data URL */
const dataURLByteSize = (dataURL: string): number => {
  const base64 = dataURL.slice(dataURL.indexOf(",") + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
};

const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
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
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [videoDims, setVideoDims] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
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
    setVideoDims({ width: video.videoWidth, height: video.videoHeight });
    setDuration(Number.isFinite(video.duration) ? video.duration : 0);
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

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (video.paused) {
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  };

  const downloadSource = () => {
    if (!dataURL || !sourceFile) {
      return;
    }
    const anchor = document.createElement("a");
    anchor.href = dataURL;
    anchor.download = sourceFile.name || "video";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  /** swap the BinaryFiles bytes for a user-picked file, keeping the fileId */
  const replaceVideo = async () => {
    if (!sourceFile?.fileId) {
      return;
    }
    const file = await pickFile(
      ["video/*", ".mkv", ".hevc", ".h265"],
      document,
    );
    if (!file) {
      return;
    }
    excalidrawAPI.addFiles(
      [
        {
          mimeType: (file.type || "video/mp4") as BinaryFileData["mimeType"],
          id: sourceFile.fileId,
          dataURL: await blobToDataURL(file),
          created: Date.now(),
          lastRetrieved: Date.now(),
        },
      ],
      { replace: true },
    );
    // rename + clear the transcoded flag; a fresh file re-runs the
    // decode/transcode detection from scratch
    excalidrawAPI.updateScene({
      elements: excalidrawAPI.getSceneElements().map((el) =>
        el.id === element.id
          ? newElementWith(el, {
              customData: {
                ...el.customData,
                sourceFile: {
                  fileId: sourceFile.fileId,
                  kind: "video",
                  name: file.name,
                },
              },
            })
          : el,
      ),
    });
    autoAttemptsRef.current = 0;
    setDecodeFailed(false);
    setTranscodeFailed(false);
    setVideoDims(null);
    setCurrentTime(0);
    setDuration(0);
  };

  const enterFullscreen = () => {
    void videoRef.current?.requestFullscreen?.().catch(() => {});
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
          src={blobUrl ?? undefined}
          onClick={togglePlay}
          onPlay={() => setPaused(false)}
          onPause={() => setPaused(true)}
          onTimeUpdate={(event) =>
            setCurrentTime(event.currentTarget.currentTime)
          }
          onVolumeChange={(event) => {
            setVolume(event.currentTarget.volume);
            setMuted(event.currentTarget.muted);
          }}
          onError={() => setDecodeFailed(true)}
          onLoadedMetadata={onLoadedMetadata}
          style={{
            width: "100%",
            height: "100%",
            background: "#000",
            objectFit: "contain",
            cursor: "pointer",
          }}
        />
      )}
    </div>
  );

  // both toolbars are selection-gated portals: inside the box they would
  // cover the video, and the embeddable overlay clips overflow
  const zoom = appState.zoom.value;
  const captureEnabled =
    paused && !busy && !failed && !decodeFailed && !transcoding;
  const playbackReady = !failed && !decodeFailed && !transcoding;
  const selected = Boolean(appState.selectedElementIds[element.id]);
  const viewport = {
    scrollX: appState.scrollX,
    scrollY: appState.scrollY,
    zoom,
  };

  const infoToolbar = selected ? (
    <ElementToolbar
      element={element}
      viewport={viewport}
      onPointerDownOutside={infoOpen ? () => setInfoOpen(false) : undefined}
    >
      <ToolbarIconButton
        label={t("mediaImport.nodeInfo")}
        active={infoOpen}
        onClick={() => setInfoOpen((prev) => !prev)}
      >
        <ToolbarInfoIcon />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={t("mediaImport.downloadSource")}
        disabled={!dataURL}
        onClick={downloadSource}
      >
        <ToolbarDownloadIcon />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={t("mediaImport.replaceVideo")}
        disabled={!sourceFile?.fileId || transcoding}
        onClick={() => void replaceVideo()}
      >
        <ToolbarReplaceIcon />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={t("mediaImport.captureFrame")}
        disabled={!captureEnabled}
        onClick={() => void captureFrame()}
      >
        <ToolbarCameraIcon />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={t("mediaImport.fullscreen")}
        disabled={!playbackReady}
        onClick={enterFullscreen}
      >
        <ToolbarFullscreenIcon />
      </ToolbarIconButton>
      {infoOpen && (
        <ToolbarPopover>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              gap: "4px 12px",
              whiteSpace: "normal",
              textAlign: "left",
            }}
          >
            <span style={{ opacity: 0.55 }}>{t("mediaImport.fileName")}</span>
            <span>{sourceFile?.name ?? "—"}</span>
            <span style={{ opacity: 0.55 }}>{t("mediaImport.dimensions")}</span>
            <span>
              {videoDims ? `${videoDims.width} × ${videoDims.height}` : "—"}
            </span>
            <span style={{ opacity: 0.55 }}>{t("mediaImport.fileSize")}</span>
            <span>{dataURL ? formatBytes(dataURLByteSize(dataURL)) : "—"}</span>
          </div>
        </ToolbarPopover>
      )}
    </ElementToolbar>
  ) : null;

  const controlsBar = selected ? (
    <VideoControlsBar
      element={element}
      viewport={viewport}
      paused={paused}
      currentTime={currentTime}
      duration={duration}
      volume={volume}
      muted={muted}
      captureEnabled={captureEnabled}
      labels={{
        play: t("mediaImport.play"),
        pause: t("mediaImport.pause"),
        mute: t("mediaImport.mute"),
        unmute: t("mediaImport.unmute"),
        capture: t("mediaImport.captureFrame"),
      }}
      onTogglePlay={togglePlay}
      onSeek={(seconds) => {
        const video = videoRef.current;
        if (video) {
          video.currentTime = seconds;
          setCurrentTime(seconds);
        }
      }}
      onVolume={(value) => {
        const video = videoRef.current;
        if (video) {
          video.volume = value;
          video.muted = value === 0;
        }
      }}
      onToggleMute={() => {
        const video = videoRef.current;
        if (video) {
          video.muted = !video.muted;
        }
      }}
      onCapture={() => void captureFrame()}
    />
  ) : null;

  return (
    <>
      {videoBox}
      {infoToolbar}
      {controlsBar}
    </>
  );
};
