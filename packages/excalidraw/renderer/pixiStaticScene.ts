/**
 * Pixi.js (WebGL) compositor for the static scene — the "plan A" rendering
 * performance path.
 *
 * Elements are still rendered by the existing Canvas2D/rough.js pipeline
 * into per-element offscreen canvases (`generateElementWithCanvas`, with
 * its WeakMap invalidation untouched); this module only replaces the final
 * per-frame blit: each offscreen canvas becomes a GPU texture on a sprite,
 * and every frame is pure GPU compositing (stage transform = scroll/zoom).
 *
 * Engaged from StaticCanvas when `isPixiRendererEnabled()` — when disabled
 * (or WebGL unavailable) the Canvas2D `_renderStaticScene` runs unchanged.
 * Export paths never come through here.
 */

import { Application, Container, Graphics, Sprite, Texture } from "pixi.js";

import {
  applyDarkModeFilter,
  BOUND_TEXT_PADDING,
  COLOR_WHITE,
  DEFAULT_REDUCED_GLOBAL_ALPHA,
  distance,
  FRAME_STYLE,
  THEME,
  throttleRAF,
} from "@excalidraw/common";

import {
  createPlaceholderEmbeddableLabel,
  elementOverlapsWithFrame,
  generateElementCanvas,
  generateElementWithCanvas,
  getBoundTextElement,
  getCanvasPadding,
  getContainingFrame,
  getElementAbsoluteCoords,
  getRenderOpacity,
  getTargetFrame,
  getUncroppedImageElement,
  isArrowElement,
  isEmbeddableElement,
  isImageElement,
  isInitializedImageElement,
  isIframeLikeElement,
  isMagicFrameElement,
  isTextElement,
  shouldApplyFrameClip,
} from "@excalidraw/element";

import { isRightAngleRads } from "@excalidraw/math";

import type { ExcalidrawElementWithCanvas } from "@excalidraw/element";

import type {
  ExcalidrawFrameLikeElement,
  ExcalidrawImageElement,
  NonDeleted,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import { getLinkIconRenderData, GridLineColor } from "./staticScene";

import type { ICanvas } from "pixi.js";

import type { StaticSceneRenderConfig } from "../scene/types";

/** max brand-new sprites revealed (texture uploaded) per frame; the rest
 *  pop in over the following frames instead of stalling a single frame */
const MAX_TEXTURE_REVEALS_PER_FRAME = 8;

/** max regenerated-canvas texture swaps (re-uploads) per frame; zooming
 *  settles into a new cache bucket which regenerates EVERY visible element
 *  canvas at once — uploading hundreds of textures in one frame stalls for
 *  seconds, so swaps are spread over frames (stale texture shows meanwhile) */
const MAX_TEXTURE_SWAPS_PER_FRAME = 16;

const Z_GRID = -1;
const Z_LINK_ICON_OFFSET = 0.5;

type ElementSpriteRecord = {
  sprite: Sprite;
  texture: Texture;
  /** the offscreen-canvas record the texture was created from — when the
   *  WeakMap cache regenerates (zoom bucket/theme/crop change), the record
   *  identity changes and we re-create the texture. Invariant: this always
   *  describes the canvas the sprite's current texture was built from (it
   *  only changes together with sprite.texture), so transforms derived from
   *  its scale can never disagree with the displayed bitmap */
  withCanvas: ExcalidrawElementWithCanvas;
  /** latest regenerated record awaiting its texture swap (rate-limited) */
  pendingWithCanvas: ExcalidrawElementWithCanvas | null;
  mask: Graphics | null;
};

type LinkIconRecord = {
  sprite: Sprite;
  texture: Texture;
  canvas: HTMLCanvasElement;
};

type FrameGroup = {
  container: Container;
  mask: Graphics;
  /** whether the container got its zIndex from a child this frame */
  zAssigned: boolean;
};

class PixiStaticSceneRenderer {
  private app: Application | null = null;
  private initPromise: Promise<Application | null> | null = null;
  private destroyed = false;
  private contextLost = false;

  /** scene-space root: applies scroll + zoom */
  private root = new Container();
  private gridGraphics = new Graphics();

  private elementSprites = new Map<string, ElementSpriteRecord>();
  private linkIconSprites = new Map<string, LinkIconRecord>();
  private frameGroups = new Map<string, FrameGroup>();
  private frameOutlines = new Map<string, Graphics>();

  /** brand-new sprites whose textures haven't been revealed (uploaded) yet */
  private revealBacklog: Sprite[] = [];
  /** records with a regenerated canvas awaiting a rate-limited texture swap */
  private swapBacklog = new Set<ElementSpriteRecord>();
  private continuationRaf: number | null = null;
  private lastConfig: StaticSceneRenderConfig | null = null;

  /** last canvas size / resolution passed to renderer.resize() */
  private lastResize = { width: -1, height: -1, resolution: -1 };

  /** last-rendered grid parameters; redraw skipped while unchanged */
  private lastGridSignature = "";

  private removeContextLostListener: (() => void) | null = null;

  get isReady(): boolean {
    return this.app !== null && !this.contextLost;
  }

  /** destroy() ran — a destroyed renderer must never be reused: its WebGL
   *  context is (or will be) lost, and a canvas can't be re-claimed */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** init failed (e.g. WebGL unsupported) before claiming the canvas */
  get isUnavailable(): boolean {
    return this.initFailed;
  }

  private initFailed = false;

  async init(canvas: HTMLCanvasElement): Promise<Application | null> {
    if (this.app) {
      return this.app;
    }
    if (!this.initPromise) {
      const dpr = canvas.ownerDocument?.defaultView?.devicePixelRatio || 1;
      const app = new Application();
      this.initPromise = app
        .init({
          // Pixi's ICanvas typing conflicts with the DOM lib's optional
          // roundRect — the runtime object is a plain HTMLCanvasElement
          canvas: canvas as unknown as ICanvas,
          preference: "webgl",
          antialias: true,
          resolution: dpr,
          autoDensity: true,
          backgroundAlpha: 0,
          // render on demand (render() calls app.render()) — the default
          // ticker would re-composite the whole stage at 60fps even when
          // nothing changed, doubling GPU load against the interactive canvas
          autoStart: false,
        })
        .then(() => {
          if (this.destroyed) {
            // destroyed while init was in flight (StrictMode remount) —
            // release the context and allow a later init to retry
            app.destroy();
            this.initPromise = null;
            return null;
          }
          this.app = app;
          this.root.sortableChildren = true;
          this.gridGraphics.zIndex = Z_GRID;
          this.root.addChild(this.gridGraphics);
          app.stage.addChild(this.root);

          const onLost = (event: Event) => {
            event.preventDefault();
            this.contextLost = true;
            console.warn(
              "Pixi static renderer: WebGL context lost; static canvas " +
                "will stay blank until reload",
            );
          };
          canvas.addEventListener("webglcontextlost", onLost);
          this.removeContextLostListener = () =>
            canvas.removeEventListener("webglcontextlost", onLost);

          return app;
        })
        .catch((error) => {
          this.initFailed = true;
          console.warn(
            "Pixi static renderer init failed, keeping Canvas2D path",
            error,
          );
          return null;
        });
    }
    return this.initPromise;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.continuationRaf !== null) {
      const win = this.app?.canvas.ownerDocument?.defaultView;
      win?.cancelAnimationFrame(this.continuationRaf);
      this.continuationRaf = null;
    }
    this.revealBacklog = [];
    this.swapBacklog.clear();
    this.removeContextLostListener?.();
    for (const record of this.elementSprites.values()) {
      record.texture.destroy(true);
    }
    this.elementSprites.clear();
    for (const record of this.linkIconSprites.values()) {
      record.texture.destroy(true);
    }
    this.linkIconSprites.clear();
    this.frameGroups.clear();
    this.frameOutlines.clear();
    if (this.app) {
      // canvas is owned by React (StaticCanvas) — don't remove it from DOM
      this.app.destroy();
      this.app = null;
    }
    this.initPromise = null;
  }

  /**
   * Renders one frame. Returns false when the renderer isn't ready (caller
   * may fall back to the Canvas2D path for that frame).
   */
  render = (config: StaticSceneRenderConfig): boolean => {
    const app = this.app;
    if (!app || this.contextLost) {
      return false;
    }
    this.lastConfig = config;

    const { appState, renderConfig, scale } = config;
    const zoom = appState.zoom.value;

    // ------------------------------------------------------------------
    // canvas size / resolution
    // ------------------------------------------------------------------
    // renderer.width/height are in physical pixels (css × resolution), so
    // track the resize inputs ourselves — with dpr ≠ 1 the raw comparison
    // was true every frame, needlessly re-running resize()
    if (
      this.lastResize.width !== appState.width ||
      this.lastResize.height !== appState.height ||
      this.lastResize.resolution !== scale
    ) {
      app.renderer.resolution = scale;
      app.renderer.resize(appState.width, appState.height);
      this.lastResize = {
        width: appState.width,
        height: appState.height,
        resolution: scale,
      };
    }

    // ------------------------------------------------------------------
    // background (mirrors bootstrapCanvas)
    // ------------------------------------------------------------------
    const bg = appState.viewBackgroundColor;
    if (typeof bg === "string" && bg !== "transparent") {
      try {
        app.renderer.background.color = applyDarkModeFilter(
          bg,
          appState.theme === THEME.DARK,
        );
      } catch {
        // corrupted persisted color — fall back to white like Canvas2D does
        app.renderer.background.color = COLOR_WHITE;
      }
      app.renderer.background.alpha = 1;
    } else {
      app.renderer.background.alpha = 0;
    }

    // scene-space root transform: screen = (scene + scroll) * zoom
    this.root.scale.set(zoom);
    this.root.position.set(appState.scrollX * zoom, appState.scrollY * zoom);

    this.renderGrid(config);

    // Swap regenerated textures at a bounded rate (see swapBacklog) BEFORE
    // placing elements: each drained record is promoted to its latest
    // withCanvas, and placeElement derives the sprite transform from
    // record.withCanvas — so a swapped sprite's new texture and new mapping
    // reach the screen in the same app.render() pass. Records past the
    // per-frame budget keep the old texture AND the old mapping until
    // drained (consistent, just blurry — no magnified flash).
    let swapsLeft = MAX_TEXTURE_SWAPS_PER_FRAME;
    for (const record of this.swapBacklog) {
      if (swapsLeft <= 0) {
        break;
      }
      this.swapBacklog.delete(record);
      swapsLeft--;
      const pending = record.pendingWithCanvas;
      record.pendingWithCanvas = null;
      if (!pending || record.sprite.destroyed) {
        continue;
      }
      // note: `pending` may lag the very latest cache entry when zooming
      // continuously — placeElement re-registers the record if so
      const texture = Texture.from(pending.canvas);
      record.texture.destroy(true);
      record.texture = texture;
      record.withCanvas = pending;
      record.sprite.texture = texture;
    }

    // ------------------------------------------------------------------
    // elements
    // ------------------------------------------------------------------
    const { elementsMap, allElementsMap, visibleElements } = config;

    const groupsToBeAddedToFrame = new Set<string>();
    visibleElements.forEach((element) => {
      if (
        element.groupIds.length > 0 &&
        appState.frameToHighlight &&
        appState.selectedElementIds[element.id] &&
        (elementOverlapsWithFrame(
          element,
          appState.frameToHighlight,
          elementsMap,
        ) ||
          element.groupIds.find((groupId) =>
            groupsToBeAddedToFrame.has(groupId),
          ))
      ) {
        element.groupIds.forEach((groupId) =>
          groupsToBeAddedToFrame.add(groupId),
        );
      }
    });
    const inFrameGroupsMap = new Map<string, boolean>();

    const seenElements = new Set<string>();
    const seenLinkIcons = new Set<string>();
    const seenFrameOutlines = new Set<string>();
    const usedFrameGroups = new Set<string>();

    let orderIndex = 0;

    const placeElement = (
      element: NonDeletedExcalidrawElement,
      zPass: number,
      isBoundText = false,
    ) => {
      if (
        !isBoundText &&
        isTextElement(element) &&
        element.containerId &&
        elementsMap.has(element.containerId)
      ) {
        // rendered together with its container
        return;
      }

      seenElements.add(element.id);
      const zIndex = zPass * 100000 + orderIndex;
      orderIndex++;

      if (element.type === "frame" || element.type === "magicframe") {
        this.renderFrameOutline(
          element as ExcalidrawFrameLikeElement,
          zIndex,
          config,
          seenFrameOutlines,
        );
        this.maybeRenderLinkIcon(element, zIndex, seenLinkIcons, config);
        return;
      }

      const withCanvas = generateElementWithCanvas(
        element,
        allElementsMap,
        renderConfig,
        appState,
      );
      if (!withCanvas) {
        return;
      }

      const dpr = app.renderer.resolution;
      let record = this.elementSprites.get(element.id);
      // The sprite displays record.withCanvas's texture (see the invariant on
      // the record type), so the mapping must derive from THAT record's
      // scale — never from a regenerated withCanvas whose swap is still
      // rate-limit pending: the stale bitmap then just goes blurry with the
      // stage zoom (same as mid-gesture) instead of flashing magnified by
      // oldScale/newScale. Records drained from swapBacklog this frame were
      // promoted before placement, so their texture and transform switch to
      // the new mapping in the same rendered frame.
      const pxPerSceneUnit =
        dpr * (record ? record.withCanvas.scale : withCanvas.scale);
      const padding = getCanvasPadding(element);
      const [x1, y1, x2, y2] = getElementAbsoluteCoords(
        element,
        allElementsMap,
      );
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;

      if (!record) {
        const texture = Texture.from(withCanvas.canvas);
        const sprite = new Sprite(texture);
        record = {
          sprite,
          texture,
          withCanvas,
          pendingWithCanvas: null,
          mask: null,
        };
        this.elementSprites.set(element.id, record);
        // brand-new textures upload on first render — reveal gradually
        sprite.visible = false;
        this.revealBacklog.push(sprite);
      } else if (record.withCanvas !== withCanvas) {
        // cache entry regenerated (zoom bucket/theme/crop) → new offscreen
        // canvas → texture swap needed; rate-limited at the start of the
        // frame (stale texture + old mapping stay paired meanwhile)
        record.pendingWithCanvas = withCanvas;
        this.swapBacklog.add(record);
      }

      // match the Canvas2D path's imageSmoothing semantics: nearest when the
      // cache is stable and the element is axis-aligned (crisper text/shapes)
      const nearest =
        !appState.shouldCacheIgnoreZoom &&
        (!element.angle || isRightAngleRads(element.angle));
      const scaleMode = nearest ? "nearest" : "linear";
      if (record.texture.source.scaleMode !== scaleMode) {
        record.texture.source.scaleMode = scaleMode;
        record.texture.source.update();
      }

      const { sprite } = record;
      // scene-space rect covered by the offscreen canvas: the element bbox
      // expanded by padding/dpr on each side (see drawElementFromCanvas)
      const left = x1 - padding / dpr;
      const top = y1 - padding / dpr;
      sprite.pivot.set(
        (cx - left) * pxPerSceneUnit,
        (cy - top) * pxPerSceneUnit,
      );
      sprite.position.set(cx, cy);
      sprite.rotation = element.angle;

      let flipX = 1;
      let flipY = 1;
      if (
        "scale" in element &&
        // pending image placeholders are not flipped (matches Canvas2D path)
        !(
          isInitializedImageElement(element) &&
          !renderConfig.imageCache.has(element.fileId)
        )
      ) {
        flipX = element.scale[0];
        flipY = element.scale[1];
      }
      sprite.scale.set(flipX / pxPerSceneUnit, flipY / pxPerSceneUnit);

      const reduceAlphaForSelection =
        appState.openDialog?.name === "elementLinkSelector" &&
        !appState.selectedElementIds[element.id] &&
        !appState.hoveredElementIds[element.id];
      sprite.alpha = getRenderOpacity(
        element,
        getContainingFrame(element, elementsMap),
        renderConfig.elementsPendingErasure,
        renderConfig.pendingFlowchartNodes,
        reduceAlphaForSelection ? DEFAULT_REDUCED_GLOBAL_ALPHA : 1,
      );

      // parent: root, or the clipping frame's masked container
      const frameId = element.frameId || appState.frameToHighlight?.id;
      let parent: Container = this.root;
      if (
        frameId &&
        appState.frameRendering.enabled &&
        appState.frameRendering.clip
      ) {
        const frame = getTargetFrame(element, elementsMap, appState);
        if (
          frame &&
          shouldApplyFrameClip(
            element,
            frame,
            appState,
            elementsMap,
            inFrameGroupsMap,
          )
        ) {
          const group = this.getFrameGroup(frame, zoom, usedFrameGroups);
          parent = group.container;
          if (!group.zAssigned) {
            group.zAssigned = true;
            group.container.zIndex = zIndex;
          }
        }
      }
      if (sprite.parent !== parent) {
        parent.addChild(sprite);
      }
      parent.sortableChildren = true;
      sprite.zIndex = zIndex;

      // arrow label hole: mask the arrow's blit out of its label's rect
      this.updateArrowLabelHoleMask(record, element, elementsMap);

      // cropping session ghost: the uncropped image at low alpha underneath
      this.updateCroppingGhost(element, zIndex, parent, config, seenElements);

      this.maybeRenderLinkIcon(element, zIndex, seenLinkIcons, config);
    };

    visibleElements
      .filter((el) => !isIframeLikeElement(el))
      .forEach((element) => {
        try {
          placeElement(element, 0);
          const boundTextElement = getBoundTextElement(element, elementsMap);
          if (boundTextElement && !boundTextElement.isDeleted) {
            placeElement(boundTextElement, 0, true);
          }
        } catch (error) {
          console.error(error, element.id);
        }
      });

    // embeddables render on top, like the Canvas2D path
    visibleElements
      .filter((el) => isIframeLikeElement(el))
      .forEach((element) => {
        try {
          placeElement(element, 1);
          if (
            isEmbeddableElement(element) &&
            renderConfig.embedsValidationStatus.get(element.id) !== true &&
            element.width &&
            element.height
          ) {
            const label = createPlaceholderEmbeddableLabel(element);
            placeElement(label as NonDeletedExcalidrawElement, 1);
          }
        } catch (error) {
          console.error(error);
        }
      });

    renderConfig.pendingFlowchartNodes?.forEach((element) => {
      try {
        placeElement(element as NonDeletedExcalidrawElement, 2);
      } catch (error) {
        console.error(error);
      }
    });

    // ------------------------------------------------------------------
    // cleanup: drop sprites/textures no longer rendered this frame
    // ------------------------------------------------------------------
    for (const [id, record] of this.elementSprites) {
      if (!seenElements.has(id)) {
        record.texture.destroy(true);
        record.sprite.destroy();
        record.mask?.destroy();
        this.elementSprites.delete(id);
        this.swapBacklog.delete(record);
      }
    }
    for (const [id, record] of this.linkIconSprites) {
      if (!seenLinkIcons.has(id)) {
        record.texture.destroy(true);
        record.sprite.destroy();
        this.linkIconSprites.delete(id);
      }
    }
    for (const [id, graphics] of this.frameOutlines) {
      if (!seenFrameOutlines.has(id)) {
        graphics.destroy();
        this.frameOutlines.delete(id);
      }
    }
    for (const [id, group] of this.frameGroups) {
      if (!usedFrameGroups.has(id)) {
        group.container.destroy({ children: false });
        group.mask.destroy();
        this.frameGroups.delete(id);
      }
    }

    // reveal (upload) a bounded number of new textures per frame
    let revealsLeft = MAX_TEXTURE_REVEALS_PER_FRAME;
    while (revealsLeft > 0 && this.revealBacklog.length) {
      const sprite = this.revealBacklog.shift()!;
      if (!sprite.destroyed) {
        sprite.visible = true;
      }
      revealsLeft--;
    }

    if (
      (this.revealBacklog.length || this.swapBacklog.size) &&
      this.continuationRaf === null
    ) {
      const win = config.canvas.ownerDocument?.defaultView;
      if (win) {
        this.continuationRaf = win.requestAnimationFrame(() => {
          this.continuationRaf = null;
          if (!this.destroyed && this.lastConfig) {
            this.render(this.lastConfig);
          }
        });
      }
    }

    // on-demand compositing (autoStart: false) — one GPU pass per state change
    app.render();

    return true;
  };

  // ---------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------

  private getFrameGroup(
    frame: ExcalidrawFrameLikeElement,
    zoom: number,
    usedFrameGroups: Set<string>,
  ): FrameGroup {
    const firstUseThisFrame = !usedFrameGroups.has(frame.id);
    usedFrameGroups.add(frame.id);
    let group = this.frameGroups.get(frame.id);
    if (!group) {
      const container = new Container();
      container.sortableChildren = true;
      const mask = new Graphics();
      container.addChild(mask);
      container.mask = mask;
      group = { container, mask, zAssigned: false };
      this.frameGroups.set(frame.id, group);
    }
    if (firstUseThisFrame) {
      // zIndex comes from the first clipped child this frame
      group.zAssigned = false;
    }
    if (group.container.parent !== this.root) {
      this.root.addChild(group.container);
    }
    // frame clip shape, in scene coords (see frameClip in staticScene.ts)
    group.mask
      .clear()
      .roundRect(
        frame.x,
        frame.y,
        frame.width,
        frame.height,
        FRAME_STYLE.radius / zoom,
      )
      .fill(0xffffff);
    return group;
  }

  /**
   * The frame outline (border stroke) is drawn directly on the main context
   * in the Canvas2D path (never cached into an offscreen canvas); here it's
   * a per-frame Graphics redraw — one roundRect, so cheap.
   */
  private renderFrameOutline(
    element: ExcalidrawFrameLikeElement,
    zIndex: number,
    config: StaticSceneRenderConfig,
    seenFrameOutlines: Set<string>,
  ): void {
    const { appState } = config;
    const outlineId = `${element.id}__frameOutline`;
    if (!appState.frameRendering.enabled || !appState.frameRendering.outline) {
      return;
    }
    seenFrameOutlines.add(outlineId);

    let graphics = this.frameOutlines.get(outlineId);
    if (!graphics) {
      graphics = new Graphics();
      this.frameOutlines.set(outlineId, graphics);
    }
    if (graphics.parent !== this.root) {
      this.root.addChild(graphics);
    }
    graphics.zIndex = zIndex;

    const isDark = appState.theme === THEME.DARK;
    let strokeColor: string = applyDarkModeFilter(
      FRAME_STYLE.strokeColor,
      isDark,
    );
    if (isMagicFrameElement(element)) {
      strokeColor = isDark ? applyDarkModeFilter("#1d8264") : "#7affd7";
    }
    // sync frames (linked file assets) get a blue outline
    if (element.customData?.syncFolder) {
      strokeColor = isDark ? applyDarkModeFilter("#2f6fdd") : "#4f8ef7";
    }

    graphics
      .clear()
      .roundRect(
        element.x,
        element.y,
        element.width,
        element.height,
        FRAME_STYLE.radius / appState.zoom.value,
      )
      .stroke({
        width: FRAME_STYLE.strokeWidth / appState.zoom.value,
        color: strokeColor,
      });
  }

  /**
   * Masks the arrow's blit out of its bound label's rect (the Canvas2D path
   * uses an even-odd clip at blit time). Uses a Graphics with a cut-out
   * hole; elements beneath the arrow keep showing through the gap.
   */
  private updateArrowLabelHoleMask(
    record: ElementSpriteRecord,
    element: NonDeletedExcalidrawElement,
    elementsMap: StaticSceneRenderConfig["elementsMap"],
  ): void {
    const boundTextElement = isArrowElement(element)
      ? getBoundTextElement(element, elementsMap)
      : null;

    if (!boundTextElement) {
      if (record.mask) {
        record.sprite.mask = null;
        record.mask.destroy();
        record.mask = null;
      }
      return;
    }

    const [, , , , boundTextCx, boundTextCy] = getElementAbsoluteCoords(
      boundTextElement,
      elementsMap,
    );
    const holeX = boundTextCx - boundTextElement.width / 2 - BOUND_TEXT_PADDING;
    const holeY =
      boundTextCy - boundTextElement.height / 2 - BOUND_TEXT_PADDING;
    const holeWidth = boundTextElement.width + BOUND_TEXT_PADDING * 2;
    const holeHeight = boundTextElement.height + BOUND_TEXT_PADDING * 2;

    // generously covers the arrow's painted extent at any rotation (the
    // hole rect stays axis-aligned in scene space)
    const [x1, y1, x2, y2] = getElementAbsoluteCoords(element, elementsMap);
    const outerHalf =
      Math.max(distance(x1, x2), distance(y1, y2)) +
      getCanvasPadding(element) * 10;

    const mask = record.mask ?? new Graphics();
    mask
      .clear()
      .rect(
        boundTextCx - outerHalf,
        boundTextCy - outerHalf,
        outerHalf * 2,
        outerHalf * 2,
      )
      .fill(0xffffff)
      .rect(holeX, holeY, holeWidth, holeHeight)
      .cut();

    // the mask lives in scene space on the root so its coordinates line up
    // regardless of the sprite's parent (frame container or root)
    if (!mask.parent) {
      this.root.addChild(mask);
    }
    record.mask = mask;
    record.sprite.mask = mask;
  }

  private updateCroppingGhost(
    element: NonDeletedExcalidrawElement,
    zIndex: number,
    parent: Container,
    config: StaticSceneRenderConfig,
    seenElements: Set<string>,
  ): void {
    const { appState, renderConfig, elementsMap, allElementsMap } = config;

    if (
      element.id !== appState.croppingElementId ||
      !isImageElement(element) ||
      element.crop === null
    ) {
      return;
    }

    const uncroppedWithCanvas = generateElementCanvas(
      getUncroppedImageElement(
        element as ExcalidrawImageElement,
        elementsMap,
      ) as NonDeleted<ExcalidrawImageElement>,
      allElementsMap,
      appState.zoom,
      renderConfig,
      appState,
    );
    if (!uncroppedWithCanvas) {
      return;
    }

    const ghostId = `${element.id}__cropGhost`;
    seenElements.add(ghostId);
    let record = this.elementSprites.get(ghostId);
    if (!record) {
      const texture = Texture.from(uncroppedWithCanvas.canvas);
      const sprite = new Sprite(texture);
      record = {
        sprite,
        texture,
        withCanvas: uncroppedWithCanvas,
        pendingWithCanvas: null,
        mask: null,
      };
      this.elementSprites.set(ghostId, record);
      sprite.visible = false;
      this.revealBacklog.push(sprite);
    } else if (record.withCanvas !== uncroppedWithCanvas) {
      const texture = Texture.from(uncroppedWithCanvas.canvas);
      record.texture.destroy(true);
      record.texture = texture;
      record.withCanvas = uncroppedWithCanvas;
      record.sprite.texture = texture;
    }

    // transform derives from the UNCROPPED element's bbox (like
    // drawElementFromCanvas does for the ghost)
    const dpr = this.app?.renderer.resolution || 1;
    const pxPerSceneUnit = dpr * uncroppedWithCanvas.scale;
    const uncroppedElement = uncroppedWithCanvas.element;
    const padding = getCanvasPadding(uncroppedElement);
    const [x1, y1, x2, y2] = getElementAbsoluteCoords(
      uncroppedElement as NonDeletedExcalidrawElement,
      allElementsMap,
    );
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const left = x1 - padding / dpr;
    const top = y1 - padding / dpr;

    const { sprite } = record;
    sprite.pivot.set((cx - left) * pxPerSceneUnit, (cy - top) * pxPerSceneUnit);
    sprite.position.set(cx, cy);
    sprite.rotation = uncroppedElement.angle;
    sprite.scale.set(1 / pxPerSceneUnit, 1 / pxPerSceneUnit);
    sprite.alpha = 0.1;
    sprite.zIndex = zIndex - 0.1;
    if (sprite.parent !== parent) {
      parent.addChild(sprite);
    }
  }

  private renderGrid(config: StaticSceneRenderConfig): void {
    const g = this.gridGraphics;
    const { appState, renderConfig } = config;
    const { renderGrid = true } = renderConfig;
    const gridSize = appState.gridSize;

    // Graphics strokes have no dash support, so a redraw tessellates every
    // dash segment — skip it entirely while the grid inputs are unchanged
    const signature = [
      renderGrid,
      gridSize,
      appState.gridStep,
      appState.scrollX,
      appState.scrollY,
      appState.zoom.value,
      appState.width,
      appState.height,
      renderConfig.theme,
    ].join("|");
    if (signature === this.lastGridSignature) {
      return;
    }
    this.lastGridSignature = signature;

    g.clear();
    if (!renderGrid || !gridSize) {
      return;
    }

    const zoom = appState.zoom;
    const { scrollX, scrollY, gridStep } = appState;
    const width = appState.width / zoom.value;
    const height = appState.height / zoom.value;

    const offsetX = (scrollX % gridSize) - gridSize;
    const offsetY = (scrollY % gridSize) - gridSize;
    const actualGridSize = gridSize * zoom.value;
    const spaceWidth = 1 / zoom.value;

    const theme = renderConfig.theme;

    // manual dash segments — Pixi strokes have no dash support. All lines
    // of one style are batched into a single stroke call.
    const drawLine = (
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      lineWidth: number,
      dashed: boolean,
    ) => {
      if (!dashed) {
        g.moveTo(x1, y1).lineTo(x2, y2);
        return;
      }
      const dashOn = lineWidth * 3;
      const dashOff = spaceWidth + (lineWidth + spaceWidth);
      const horizontal = y1 === y2;
      const length = horizontal ? Math.abs(x2 - x1) : Math.abs(y2 - y1);
      let cursor = 0;
      while (cursor < length) {
        const segEnd = Math.min(cursor + dashOn, length);
        if (horizontal) {
          g.moveTo(x1 + cursor, y1).lineTo(x1 + segEnd, y1);
        } else {
          g.moveTo(x1, y1 + cursor).lineTo(x1, y1 + segEnd);
        }
        cursor = segEnd + dashOff;
      }
    };

    const strokeBatch = (lines: Array<readonly number[]>, bold: boolean) => {
      if (!lines.length) {
        return;
      }
      const lineWidth = Math.min(1 / zoom.value, bold ? 4 : 1);
      for (const [x1, y1, x2, y2] of lines) {
        drawLine(x1, y1, x2, y2, lineWidth, !bold);
      }
      g.stroke({
        width: lineWidth,
        color: bold ? GridLineColor[theme].bold : GridLineColor[theme].regular,
      });
    };

    const regular: Array<readonly number[]> = [];
    const bold: Array<readonly number[]> = [];

    for (let x = offsetX; x < offsetX + width + gridSize * 2; x += gridSize) {
      const isBold =
        gridStep > 1 && Math.round(x - scrollX) % (gridStep * gridSize) === 0;
      if (!isBold && actualGridSize < 10) {
        continue;
      }
      (isBold ? bold : regular).push([
        x,
        offsetY - gridSize,
        x,
        Math.ceil(offsetY + height + gridSize * 2),
      ] as const);
    }
    for (let y = offsetY; y < offsetY + height + gridSize * 2; y += gridSize) {
      const isBold =
        gridStep > 1 && Math.round(y - scrollY) % (gridStep * gridSize) === 0;
      if (!isBold && actualGridSize < 10) {
        continue;
      }
      (isBold ? bold : regular).push([
        offsetX - gridSize,
        y,
        Math.ceil(offsetX + width + gridSize * 2),
        y,
      ] as const);
    }

    strokeBatch(regular, false);
    strokeBatch(bold, true);
  }

  private maybeRenderLinkIcon(
    element: NonDeletedExcalidrawElement,
    zIndex: number,
    seenLinkIcons: Set<string>,
    config: StaticSceneRenderConfig,
  ): void {
    const { appState, renderConfig, elementsMap } = config;
    if (renderConfig.isExporting || renderConfig.renderLinks === false) {
      return;
    }
    const data = getLinkIconRenderData(element, appState, elementsMap);
    if (!data) {
      return;
    }
    seenLinkIcons.add(element.id);

    let record = this.linkIconSprites.get(element.id);
    if (!record) {
      const texture = Texture.from(data.canvas);
      const sprite = new Sprite(texture);
      record = { sprite, texture, canvas: data.canvas };
      this.linkIconSprites.set(element.id, record);
      this.root.addChild(sprite);
    } else if (record.canvas !== data.canvas) {
      // the icon canvas is recreated on zoom change → new texture
      const texture = Texture.from(data.canvas);
      record.texture.destroy(true);
      record.texture = texture;
      record.canvas = data.canvas;
      record.sprite.texture = texture;
    }

    const { sprite } = record;
    const dpr = this.app?.renderer.resolution || 1;
    const pxPerUnit = dpr * appState.zoom.value;
    sprite.pivot.set(
      (data.centerX - data.x) * pxPerUnit,
      (data.centerY - data.y) * pxPerUnit,
    );
    sprite.position.set(data.centerX, data.centerY);
    sprite.rotation = data.angle;
    sprite.scale.set(1 / pxPerUnit, 1 / pxPerUnit);
    sprite.alpha = data.opacity;
    sprite.zIndex = zIndex + Z_LINK_ICON_OFFSET;
    if (sprite.parent !== this.root) {
      this.root.addChild(sprite);
    }
  }
}

// ---------------------------------------------------------------------------
// module-level renderer registry (one per canvas)
// ---------------------------------------------------------------------------

const renderers = new WeakMap<HTMLCanvasElement, PixiStaticSceneRenderer>();

/**
 * Unmount-time destruction is deferred one macrotask: React StrictMode (dev)
 * unmounts and immediately remounts on the SAME canvas element, and a canvas
 * only ever gets one WebGL context — an in-flight init of the destroyed
 * renderer would `loseContext()` out from under the remounted one, leaving a
 * permanently blank static canvas. A remount cancels the pending destroy; a
 * real unmount lets it run.
 */
const pendingDestroys = new WeakMap<HTMLCanvasElement, number>();

const cancelPendingDestroy = (canvas: HTMLCanvasElement): void => {
  const win = canvas.ownerDocument?.defaultView;
  const timeoutId = pendingDestroys.get(canvas);
  if (win && timeoutId !== undefined) {
    win.clearTimeout(timeoutId);
  }
  pendingDestroys.delete(canvas);
};

const throttledRender = throttleRAF((fn: () => boolean) => {
  fn();
});

/**
 * Renders the static scene via the Pixi compositor.
 *
 * - "rendered": frame handed to Pixi (possibly throttled to RAF)
 * - "pending": renderer still initializing — the caller should skip this
 *   frame (NOT fall back to Canvas2D: once Pixi claims the canvas, its 2d
 *   context is gone for good)
 * - "unavailable": init failed before claiming the canvas — the caller may
 *   permanently fall back to the Canvas2D path
 */
export const renderPixiStaticScene = (
  config: StaticSceneRenderConfig,
  throttle?: boolean,
): "rendered" | "pending" | "unavailable" => {
  if (!config.canvas) {
    return "unavailable";
  }
  // a StrictMode remount lands here one macrotask before the deferred
  // destroy fires — cancel it and keep using the same renderer/context
  cancelPendingDestroy(config.canvas);
  let renderer = renderers.get(config.canvas);
  if (renderer?.isDestroyed) {
    // real destroy already ran (flag toggle, HMR) — the old context is
    // gone; start over with a fresh renderer on a fresh context attempt
    renderers.delete(config.canvas);
    renderer = undefined;
  }
  if (!renderer) {
    renderer = new PixiStaticSceneRenderer();
    renderers.set(config.canvas, renderer);
  }
  if (renderer.isUnavailable) {
    return "unavailable";
  }
  if (!renderer.isReady) {
    void renderer.init(config.canvas).then((app) => {
      if (app) {
        // first frame as soon as init completes
        renderer.render(config);
      }
    });
    return "pending";
  }
  if (throttle) {
    const r = renderer;
    throttledRender(() => r.render(config));
    return "rendered";
  }
  renderer.render(config);
  return "rendered";
};

/** tears down the Pixi renderer bound to `canvas` (unmount / flag off) */
export const destroyPixiStaticScene = (canvas: HTMLCanvasElement): void => {
  const renderer = renderers.get(canvas);
  if (!renderer) {
    return;
  }
  const win = canvas.ownerDocument?.defaultView;
  if (!win) {
    renderer.destroy();
    renderers.delete(canvas);
    return;
  }
  cancelPendingDestroy(canvas);
  const timeoutId = win.setTimeout(() => {
    pendingDestroys.delete(canvas);
    renderer.destroy();
    renderers.delete(canvas);
  }, 0);
  pendingDestroys.set(canvas, timeoutId);
};
