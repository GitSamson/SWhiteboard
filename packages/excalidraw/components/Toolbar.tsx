import clsx from "clsx";

import { t } from "../i18n";

import { useEditorInterface, useStylesPanelMode } from "./App";
import { HintViewer } from "./HintViewer";
import { Island } from "./Island";
import { LockButton } from "./LockButton";
import { PenModeButton } from "./PenModeButton";
import Stack from "./Stack";
import {
  ArrowToolButton,
  AutoshapeToolButton,
  BucketFillToolButton,
  DiamondToolButton,
  EllipseToolButton,
  EmbeddableToolButton,
  EraserToolButton,
  FrameToolButton,
  FreedrawToolPopover,
  FreedrawToolButton,
  HandToolButton,
  ImageToolButton,
  LaserToolButton,
  LassoToolButton,
  LineToolButton,
  RectangleToolButton,
  SelectionToolButton,
  SelectionToolPopover,
  TextToolButton,
} from "./Tools";

import type {
  AppClassProperties,
  AppProps,
  AppState,
  UIAppState,
} from "../types";

/**
 * The main (desktop/tablet) toolbar island — pinned to the BOTTOM edge of
 * the canvas (see `.App-toolbar` in styles.scss). All drawing tools are
 * laid out flat; the former "More tools" dropdown entries (frame, web
 * embed, draw-to-shape, laser, bucket fill) are inline buttons. The
 * dropdown's "Generate" section (text-to-diagram / mermaid / wireframe-to-
 * code) is intentionally NOT on the toolbar.
 */
export const Toolbar = ({
  app,
  appState,
  setAppState,
  UIOptions,
  onPenModeToggle,
  onLockToggle,
  heading,
}: {
  app: AppClassProperties;
  appState: UIAppState;
  setAppState: React.Component<any, AppState>["setState"];
  UIOptions: AppProps["UIOptions"];
  onPenModeToggle: AppClassProperties["togglePenMode"];
  onLockToggle: () => void;
  heading: React.ReactNode;
}) => {
  const editorInterface = useEditorInterface();
  const isCompactStylesPanel = useStylesPanelMode() === "compact";

  const activeTool = appState.activeTool;
  const toolProps = { app, activeTool };

  return (
    <Island
      padding={1}
      className={clsx("App-toolbar", {
        "zen-mode": appState.zenModeEnabled,
        "App-toolbar--compact": isCompactStylesPanel,
      })}
      data-viewport-ui="top"
    >
      <HintViewer
        appState={appState}
        isMobile={editorInterface.formFactor === "phone"}
        editorInterface={editorInterface}
        app={app}
      />
      {heading}
      <Stack.Row gap={isCompactStylesPanel ? 0.5 : 1}>
        {/* in compact UI the pen mode button is rendered as a separate
            floating button below the compact actions menu */}
        {!isCompactStylesPanel && (
          <PenModeButton
            checked={appState.penMode}
            onChange={() => onPenModeToggle(null)}
            title={t("toolBar.penMode")}
            penDetected={appState.penDetected}
          />
        )}
        {app.props.activeTool == null && (
          <>
            <LockButton
              checked={appState.activeTool.locked}
              onChange={onLockToggle}
              title={t("toolBar.lock")}
              // the active tool — including its lock state — is host-controlled
              disabled={app.props.activeTool != null}
            />

            <div
              className="App-toolbar__divider"
              style={{ marginRight: "0.25rem" }}
            />
          </>
        )}

        <HandToolButton {...toolProps} hideKeyBinding />
        {isCompactStylesPanel ? (
          <SelectionToolPopover {...toolProps} setAppState={setAppState} />
        ) : appState.preferredSelectionTool.type === "lasso" ? (
          <LassoToolButton {...toolProps} />
        ) : (
          <SelectionToolButton {...toolProps} />
        )}
        <RectangleToolButton {...toolProps} />
        <DiamondToolButton {...toolProps} />
        <EllipseToolButton {...toolProps} />
        <ArrowToolButton {...toolProps} />
        <LineToolButton {...toolProps} />
        {isCompactStylesPanel ? (
          <FreedrawToolPopover {...toolProps} />
        ) : (
          <FreedrawToolButton {...toolProps} />
        )}
        <TextToolButton {...toolProps} />
        {UIOptions.tools?.image !== false && <ImageToolButton {...toolProps} />}
        {app.props.renderCustomToolbarItems?.()}
        <EraserToolButton {...toolProps} />

        <div
          className="App-toolbar__divider"
          style={{ marginLeft: "0.25rem" }}
        />

        {/* former "More tools" dropdown entries, inlined */}
        <FrameToolButton {...toolProps} />
        <EmbeddableToolButton {...toolProps} />
        <AutoshapeToolButton {...toolProps} />
        {/* in collab the laser pointer gets its own island next to the
            toolbar (with collaborator awareness), so skip the inline one */}
        {!app.props.isCollaborating && <LaserToolButton {...toolProps} />}
        <BucketFillToolButton {...toolProps} />
      </Stack.Row>
    </Island>
  );
};
