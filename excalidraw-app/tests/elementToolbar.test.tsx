/**
 * DOM smoke tests for the floating element toolbar (`media/ElementToolbar`):
 * portal pill positioning, hover tooltips, and outside-pointer reporting.
 * Kept in a .tsx file — jsdom renders the pill fine (no canvas involved).
 */

import { describe, expect, it, vi } from "vitest";

import { fireEvent, render, screen } from "@testing-library/react";

import {
  ELEMENT_TOOLBAR_GAP,
  ElementToolbar,
  ToolbarIconButton,
} from "../media/ElementToolbar";

describe("ElementToolbar component", () => {
  const element = { x: 100, y: 200, width: 480, height: 640 };
  const viewport = { scrollX: 0, scrollY: 0, zoom: 1 };

  it("renders the pill above the element as a body portal", () => {
    render(
      <ElementToolbar element={element} viewport={viewport}>
        <ToolbarIconButton label="截帧" onClick={() => {}}>
          <span />
        </ToolbarIconButton>
      </ElementToolbar>,
    );
    const button = screen.getByRole("button", { name: "截帧" });
    const pill = button.closest("div")!;
    expect(pill.parentElement).toBe(document.body);
    expect(pill.style.left).toBe("340px");
    expect(pill.style.top).toBe(`${200 - ELEMENT_TOOLBAR_GAP}px`);
    expect(pill.style.transform).toBe("translate(-50%, -100%)");
  });

  it("shows the tooltip on hover and fires onClick", () => {
    const onClick = vi.fn();
    render(
      <ElementToolbar element={element} viewport={viewport}>
        <ToolbarIconButton label="截帧" onClick={onClick}>
          <span />
        </ToolbarIconButton>
      </ElementToolbar>,
    );
    const button = screen.getByRole("button", { name: "截帧" });
    // no tooltip text before hover (aria-label doesn't create text content)
    expect(screen.queryByText("截帧")).toBeNull();
    fireEvent.mouseEnter(button.parentElement!);
    expect(screen.getByText("截帧")).toBeTruthy();
    fireEvent.mouseLeave(button.parentElement!);
    expect(screen.queryByText("截帧")).toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not show a tooltip for a disabled button", () => {
    render(
      <ElementToolbar element={element} viewport={viewport}>
        <ToolbarIconButton label="截帧" disabled onClick={() => {}}>
          <span />
        </ToolbarIconButton>
      </ElementToolbar>,
    );
    const button = screen.getByRole("button", { name: "截帧" });
    fireEvent.mouseEnter(button.parentElement!);
    expect(screen.queryByText("截帧")).toBeNull();
  });

  it("reports pointer-downs outside the pill but not inside", () => {
    const onOutside = vi.fn();
    render(
      <ElementToolbar
        element={element}
        viewport={viewport}
        onPointerDownOutside={onOutside}
      >
        <ToolbarIconButton label="截帧" onClick={() => {}}>
          <span />
        </ToolbarIconButton>
      </ElementToolbar>,
    );
    const button = screen.getByRole("button", { name: "截帧" });
    fireEvent.pointerDown(button);
    expect(onOutside).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onOutside).toHaveBeenCalledTimes(1);
  });
});
