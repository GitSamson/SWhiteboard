/**
 * Shared floating icon toolbar for element-context actions (PDF page tools,
 * video frame capture, …), styled after the reference "infinite-canvas" UI:
 * a white rounded icon pill hovering ABOVE the selected element (flipping
 * below it when there is no viewport room), icon-only buttons with a small
 * hover tooltip.
 *
 * Rendered as a portal to document.body and positioned in screen space from
 * the element's scene box + viewport — the caller re-renders on
 * scroll/zoom/element changes, so the pill tracks the element (including
 * in-place drag mutations).
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * UI font stack matching the library's `--ui-font` (styles.scss). The pill
 * portals to document.body — outside the `.excalidraw` root that defines the
 * variable — so the stack must be repeated here, otherwise pill text (page
 * indicator, HD badge, timecodes, tooltips) falls back to the browser default.
 */
export const ELEMENT_TOOLBAR_FONT_FAMILY =
  'Assistant, system-ui, BlinkMacSystemFont, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export interface ToolbarElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ToolbarViewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

/** pill height (px) — keep in sync with the styles below */
export const ELEMENT_TOOLBAR_HEIGHT = 44;
/** screen-px gap between the element box and the pill */
export const ELEMENT_TOOLBAR_GAP = 8;

export interface ElementToolbarLayout {
  left: number;
  top: number;
  placement: "above" | "below";
}

/**
 * Screen-space position of the pill: horizontally centered on the element,
 * hovering above its top edge; flips below the element when the top edge is
 * too close to the viewport top for the pill + gap to fit.
 */
export const computeElementToolbarLayout = (
  element: ToolbarElementBox,
  viewport: ToolbarViewport,
): ElementToolbarLayout => {
  const { scrollX, scrollY, zoom } = viewport;
  const left = (element.x + scrollX) * zoom + (element.width * zoom) / 2;
  const topEdge = (element.y + scrollY) * zoom;
  const above = topEdge - ELEMENT_TOOLBAR_GAP - ELEMENT_TOOLBAR_HEIGHT >= 0;
  return {
    left,
    top: above
      ? topEdge - ELEMENT_TOOLBAR_GAP
      : (element.y + scrollY + element.height) * zoom + ELEMENT_TOOLBAR_GAP,
    placement: above ? "above" : "below",
  };
};

export const ElementToolbar: React.FC<{
  element: ToolbarElementBox;
  viewport: ToolbarViewport;
  /** fired on pointer-down outside the pill (used to close popovers) */
  onPointerDownOutside?: () => void;
  children: React.ReactNode;
}> = ({ element, viewport, onPointerDownOutside, children }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const layout = computeElementToolbarLayout(element, viewport);

  useEffect(() => {
    if (!onPointerDownOutside) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        onPointerDownOutside();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [onPointerDownOutside]);

  return createPortal(
    <div
      ref={rootRef}
      style={{
        position: "absolute",
        left: layout.left,
        top: layout.top,
        transform:
          layout.placement === "above"
            ? "translate(-50%, -100%)"
            : "translate(-50%, 0)",
        display: "flex",
        alignItems: "center",
        gap: 2,
        height: ELEMENT_TOOLBAR_HEIGHT,
        padding: "0 8px",
        background: "#ffffff",
        border: "1px solid rgba(0, 0, 0, 0.1)",
        borderRadius: 14,
        boxShadow: "0 8px 28px rgba(15, 23, 42, 0.12)",
        color: "#242529",
        fontFamily: ELEMENT_TOOLBAR_FONT_FAMILY,
        zIndex: 6,
      }}
      // keep clicks on the pill from reaching the canvas / deselecting
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
};

export const ToolbarIconButton: React.FC<{
  /** tooltip text shown above the button on hover */
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}> = ({
  label,
  onClick,
  disabled = false,
  active = false,
  danger = false,
  children,
}) => {
  const [hover, setHover] = useState(false);
  return (
    <span
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          minWidth: 32,
          height: 32,
          padding: "0 6px",
          border: "none",
          borderRadius: 8,
          background: active
            ? "#eeeeef"
            : hover && !disabled
            ? "#f0f0f1"
            : "transparent",
          color: danger ? "#ef4444" : "#242529",
          opacity: disabled ? 0.35 : 1,
          cursor: disabled ? "default" : "pointer",
          transition: "background 0.12s",
        }}
      >
        {children}
      </button>
      {hover && !disabled && (
        <span
          style={{
            position: "absolute",
            bottom: "calc(100% + 10px)",
            left: "50%",
            transform: "translateX(-50%)",
            padding: "4px 8px",
            background: "#ffffff",
            border: "1px solid rgba(0, 0, 0, 0.08)",
            borderRadius: 6,
            boxShadow: "0 8px 24px rgba(15, 23, 42, 0.16)",
            color: "#242529",
            fontSize: 12,
            fontWeight: 500,
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          {label}
        </span>
      )}
    </span>
  );
};

export const ToolbarDivider: React.FC = () => (
  <span
    style={{
      width: 1,
      height: 20,
      margin: "0 4px",
      background: "rgba(0, 0, 0, 0.1)",
    }}
  />
);

/**
 * Small popover card anchored under the pill (used for multi-field tools
 * like the PDF page-range expand). Must be a child of ElementToolbar so it
 * positions relative to the pill.
 */
export const ToolbarPopover: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <div
    style={{
      position: "absolute",
      top: "calc(100% + 8px)",
      left: "50%",
      transform: "translateX(-50%)",
      display: "flex",
      alignItems: "center",
      gap: 6,
      padding: "8px 10px",
      background: "#ffffff",
      border: "1px solid rgba(0, 0, 0, 0.1)",
      borderRadius: 12,
      boxShadow: "0 8px 28px rgba(15, 23, 42, 0.12)",
      color: "#242529",
      fontSize: 12,
      whiteSpace: "nowrap",
    }}
  >
    {children}
  </div>
);
