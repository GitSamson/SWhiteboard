/**
 * Custom playback controls for imported video elements, rendered as a white
 * icon pill BELOW the video box (portal, same visual language as
 * `media/ElementToolbar`) and only while the video is selected. Replaces the
 * native `<video controls>`: play/pause, seek bar, volume + mute, and
 * capture-frame.
 */

import { createPortal } from "react-dom";

import {
  ELEMENT_TOOLBAR_FONT_FAMILY,
  ToolbarIconButton,
} from "../media/ElementToolbar";
import {
  ToolbarCameraIcon,
  ToolbarPauseIcon,
  ToolbarPlayIcon,
  ToolbarVolumeIcon,
  ToolbarVolumeMutedIcon,
} from "../media/toolbarIcons";

import type {
  ToolbarElementBox,
  ToolbarViewport,
} from "../media/ElementToolbar";

const formatClock = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
};

export const VideoControlsBar: React.FC<{
  element: ToolbarElementBox;
  viewport: ToolbarViewport;
  paused: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  captureEnabled: boolean;
  labels: {
    play: string;
    pause: string;
    mute: string;
    unmute: string;
    capture: string;
  };
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  onVolume: (volume: number) => void;
  onToggleMute: () => void;
  onCapture: () => void;
}> = ({
  element,
  viewport,
  paused,
  currentTime,
  duration,
  volume,
  muted,
  captureEnabled,
  labels,
  onTogglePlay,
  onSeek,
  onVolume,
  onToggleMute,
  onCapture,
}) => {
  const { scrollX, scrollY, zoom } = viewport;
  const left = (element.x + scrollX) * zoom + (element.width * zoom) / 2;
  const top = (element.y + scrollY + element.height) * zoom + 8;
  const width = Math.max(320, Math.min(element.width * zoom, 560));

  return createPortal(
    <div
      style={{
        position: "absolute",
        left,
        top,
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 6,
        width,
        height: 44,
        padding: "0 10px",
        background: "#ffffff",
        border: "1px solid rgba(0, 0, 0, 0.1)",
        borderRadius: 14,
        boxShadow: "0 8px 28px rgba(15, 23, 42, 0.12)",
        color: "#242529",
        fontSize: 11,
        fontFamily: ELEMENT_TOOLBAR_FONT_FAMILY,
        fontVariantNumeric: "tabular-nums",
        zIndex: 6,
      }}
      // keep clicks on the bar from reaching the canvas / deselecting
      onPointerDown={(event) => event.stopPropagation()}
    >
      <ToolbarIconButton
        label={paused ? labels.play : labels.pause}
        onClick={onTogglePlay}
      >
        {paused ? <ToolbarPlayIcon /> : <ToolbarPauseIcon />}
      </ToolbarIconButton>
      <span>{formatClock(currentTime)}</span>
      <input
        type="range"
        aria-label={labels.play}
        min={0}
        max={duration > 0 ? duration : 0}
        step={0.1}
        value={Math.min(currentTime, duration || 0)}
        onChange={(event) => onSeek(Number(event.target.value))}
        style={{ flex: 1, minWidth: 0, accentColor: "#6965db" }}
      />
      <span>{formatClock(duration)}</span>
      <ToolbarIconButton
        label={muted ? labels.unmute : labels.mute}
        onClick={onToggleMute}
      >
        {muted || volume === 0 ? (
          <ToolbarVolumeMutedIcon />
        ) : (
          <ToolbarVolumeIcon />
        )}
      </ToolbarIconButton>
      <input
        type="range"
        aria-label={labels.mute}
        min={0}
        max={1}
        step={0.05}
        value={muted ? 0 : volume}
        onChange={(event) => onVolume(Number(event.target.value))}
        style={{ width: 56, accentColor: "#6965db" }}
      />
      <ToolbarIconButton
        label={labels.capture}
        disabled={!captureEnabled}
        onClick={onCapture}
      >
        <ToolbarCameraIcon />
      </ToolbarIconButton>
    </div>,
    document.body,
  );
};
