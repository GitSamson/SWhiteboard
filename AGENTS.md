# Guidelines

- For new DOM/browser API usage, use `app.ownerDocument` and `app.ownerWindow` instead of globals; without `app`, derive them from the mounted node's `ownerDocument` and its `defaultView`.

# Linked file assets (excalidraw-app/linkedAssets)

- Feature-gated by `VITE_APP_ENABLE_LINKED_FILES` (string compare against `"true"`); desktop Chrome/Edge only (File System Access API).
- App-layer code lives in `excalidraw-app/linkedAssets/`; the library (`packages/`) must never import from it — the library calls into the app through `packages/excalidraw/linkedAssetsBridge.ts` (`getLinkedAssetsBridge()`, null = feature disabled) and the image-cache resolver injected via `setLinkedImageResolver()` (`packages/element/src/image.ts`).
- Link metadata lives in `element.customData.linkedFile`; sync-frame folder bindings and the manifest live in `frame.customData.syncFolder`. Both survive scene save/load automatically — never store feature data in the linked folder itself.
- Linked images keep only a webp thumbnail (max side 512px) in BinaryFiles; originals are read from disk. Background reconciliation (verifier) must use `CaptureUpdateAction.NEVER` so it never pollutes undo history.
- Duplicating a linked image (copy/paste, duplicate action, alt-drag) clones `customData.linkedFile`; the sync engine detects clones via the manifest (`duplicate.ts`) and gives each clone its own on-disk copy with a sequence suffix (`name-1`, `name-2`…).
- Deleting a linked image on the board only hides it (native `isDeleted`); the file on disk is untouched. Real deletion happens via the sync frame's context menu "delete hidden images" (`frameActions.ts` → `deletion.ts`, interactive permission). The frame menu also has "show hidden images" and "reset layout". Deleting the sync frame itself strips the link metadata from its images but never deletes files (`unlinkFolderLinks`).
- Folder files unknown to the manifest are auto-imported into the frame in a grid (`importer.ts`); cell size matches the average of existing frame images, falling back to a share of the frame size.
- The sidebar tab listing sync frames lives in `linkedAssets/ui/SyncFoldersPanel.tsx`, wired into `excalidraw-app/components/AppSidebar.tsx`.
- New app-layer jotai atoms go in `linkedAssets/state.ts`; jotai is only imported via `excalidraw-app/app-jotai.ts`.
