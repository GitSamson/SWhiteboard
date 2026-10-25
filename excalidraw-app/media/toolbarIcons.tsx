/**
 * Inline lucide-style stroke icons for the element toolbar — the library's
 * icon set has no glyphs for page turns / page extraction / frame capture.
 */

import React from "react";

const iconProps = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export const ToolbarChevronLeftIcon = () => (
  <svg {...iconProps}>
    <path d="m15 18-6-6 6-6" />
  </svg>
);

export const ToolbarChevronRightIcon = () => (
  <svg {...iconProps}>
    <path d="m9 18 6-6-6-6" />
  </svg>
);

/** extract the current page as an image (lucide "image-down") */
export const ToolbarImageDownIcon = () => (
  <svg {...iconProps}>
    <path d="M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10l-3.1-3.1a2 2 0 0 0-2.814.014L6 21" />
    <path d="m14 19 3 3 3-3" />
    <path d="M17 22v-5.5" />
    <circle cx="9" cy="9" r="2" />
  </svg>
);

/** expand a page range (lucide "layers") */
export const ToolbarLayersIcon = () => (
  <svg {...iconProps}>
    <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
    <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
    <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
  </svg>
);

/** capture the current video frame (lucide "camera") */
export const ToolbarCameraIcon = () => (
  <svg {...iconProps}>
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
    <circle cx="12" cy="13" r="3" />
  </svg>
);

/** HD quality toggle — no glyph for it, a bold "HD" wordmark reads best */
export const ToolbarHdMark: React.FC<{ active?: boolean }> = ({ active }) => (
  <span
    aria-hidden="true"
    style={{
      fontSize: 11,
      fontWeight: active ? 800 : 600,
      letterSpacing: 0.5,
      lineHeight: 1,
    }}
  >
    HD
  </span>
);

/** download / save (lucide "download") */
export const ToolbarDownloadIcon = () => (
  <svg {...iconProps}>
    <path d="M12 15V3" />
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10 5 5 5-5" />
  </svg>
);

/** export as PDF document (lucide "file-text") */
export const ToolbarFileTextIcon = () => (
  <svg {...iconProps}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M10 9H8" />
    <path d="M16 13H8" />
    <path d="M16 17H8" />
  </svg>
);

/** node info (lucide "info") */
export const ToolbarInfoIcon = () => (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </svg>
);

/** replace the source file (lucide "refresh-ccw") */
export const ToolbarReplaceIcon = () => (
  <svg {...iconProps}>
    <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
    <path d="M16 16h5v5" />
  </svg>
);

/** fullscreen (lucide "maximize") */
export const ToolbarFullscreenIcon = () => (
  <svg {...iconProps}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
    <path d="M3 16v3a2 2 0 0 0 2 2h3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </svg>
);

/** play (lucide "play") */
export const ToolbarPlayIcon = () => (
  <svg {...iconProps}>
    <polygon points="6 3 20 12 6 21 6 3" />
  </svg>
);

/** pause (lucide "pause") */
export const ToolbarPauseIcon = () => (
  <svg {...iconProps}>
    <rect x="14" y="4" width="4" height="16" rx="1" />
    <rect x="6" y="4" width="4" height="16" rx="1" />
  </svg>
);

/** volume (lucide "volume-2") */
export const ToolbarVolumeIcon = () => (
  <svg {...iconProps}>
    <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
    <path d="M16 9a5 5 0 0 1 0 6" />
    <path d="M19.364 18.364a9 9 0 0 0 0-12.728" />
  </svg>
);

/** muted (lucide "volume-x") */
export const ToolbarVolumeMutedIcon = () => (
  <svg {...iconProps}>
    <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
    <line x1="22" x2="16" y1="9" y2="15" />
    <line x1="16" x2="22" y1="9" y2="15" />
  </svg>
);

/** crop the selected image (lucide "crop") */
export const ToolbarCropIcon = () => (
  <svg {...iconProps}>
    <path d="M6 2v14a2 2 0 0 0 2 2h14" />
    <path d="M18 22V8a2 2 0 0 0-2-2H2" />
  </svg>
);

/** copy to clipboard (lucide "copy") */
export const ToolbarCopyIcon = () => (
  <svg {...iconProps}>
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </svg>
);
