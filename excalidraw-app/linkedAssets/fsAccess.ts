/**
 * Thin wrappers around the File System Access API used by the
 * "linked file assets" feature. Everything here is dependency-light and
 * takes injectable handles/windows so it stays testable in jsdom
 * (where the API does not exist).
 */

// the project's TS lib.dom lacks these newer FS Access API members
declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      id?: string;
      mode?: "read" | "readwrite";
    }) => Promise<FileSystemDirectoryHandle>;
  }

  interface FileSystemHandle {
    queryPermission?: (descriptor: {
      mode?: "read" | "readwrite";
    }) => Promise<PermissionState>;
    requestPermission?: (descriptor: {
      mode?: "read" | "readwrite";
    }) => Promise<PermissionState>;
    /** Chrome-only; when absent, callers fall back to copy + delete */
    move?: (
      destination: FileSystemDirectoryHandle | string,
      name?: string,
    ) => Promise<void>;
  }
}

export const isFileSystemAccessSupported = (win: Window = window): boolean => {
  return "showDirectoryPicker" in win;
};

export const pickDirectory = async (
  win: Window = window,
): Promise<FileSystemDirectoryHandle> => {
  if (!isFileSystemAccessSupported(win)) {
    throw new Error("File System Access API is not supported in this browser");
  }
  return win.showDirectoryPicker!({ mode: "readwrite" });
};

const splitRelPath = (relPath: string): string[] => {
  const segments = relPath.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid relative path: "${relPath}"`);
  }
  return segments;
};

const resolveParentDirectory = async (
  root: FileSystemDirectoryHandle,
  relPath: string,
  opts: { create?: boolean } = {},
): Promise<{ parent: FileSystemDirectoryHandle; name: string }> => {
  const segments = splitRelPath(relPath);
  const name = segments.pop()!;
  let parent = root;
  for (const segment of segments) {
    parent = await parent.getDirectoryHandle(segment, {
      create: opts.create ?? false,
    });
  }
  return { parent, name };
};

/** resolves a relPath like "cats/1.png" to a file handle under `root` */
export const getFileHandleByRelPath = async (
  root: FileSystemDirectoryHandle,
  relPath: string,
  opts: { create?: boolean } = {},
): Promise<FileSystemFileHandle> => {
  const { parent, name } = await resolveParentDirectory(root, relPath, opts);
  return parent.getFileHandle(name, { create: opts.create ?? false });
};

export const readFileByRelPath = async (
  root: FileSystemDirectoryHandle,
  relPath: string,
): Promise<File> => {
  const handle = await getFileHandleByRelPath(root, relPath);
  return handle.getFile();
};

export const writeFileByRelPath = async (
  root: FileSystemDirectoryHandle,
  relPath: string,
  data: FileSystemWriteChunkType,
): Promise<void> => {
  const handle = await getFileHandleByRelPath(root, relPath, {
    create: true,
  });
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
  } finally {
    await writable.close();
  }
};

/** deletes the file at `relPath`; throws NotFoundError when absent */
export const deleteFileByRelPath = async (
  root: FileSystemDirectoryHandle,
  relPath: string,
): Promise<void> => {
  const { parent, name } = await resolveParentDirectory(root, relPath);
  await parent.removeEntry(name);
};

/**
 * renames the file at `relPath` to `newName` (same directory).
 * Prefers `FileSystemFileHandle.move()` when available, otherwise falls
 * back to copy + delete. Returns the new relPath.
 */
export const renameFileByRelPath = async (
  root: FileSystemDirectoryHandle,
  relPath: string,
  newName: string,
): Promise<string> => {
  const sanitizedName = sanitizeFileName(newName);
  const handle = await getFileHandleByRelPath(root, relPath);

  if (typeof handle.move === "function") {
    await handle.move(sanitizedName);
  } else {
    const { parent, name } = await resolveParentDirectory(root, relPath);
    const file = await handle.getFile();
    const newHandle = await parent.getFileHandle(sanitizedName, {
      create: true,
    });
    const writable = await newHandle.createWritable();
    try {
      await writable.write(file);
    } finally {
      await writable.close();
    }
    await parent.removeEntry(name);
  }

  const segments = splitRelPath(relPath);
  segments[segments.length - 1] = sanitizedName;
  return segments.join("/");
};

/**
 * Returns a root-level relPath based on `displayName` that collides neither
 * with `takenPaths` (e.g. the frame manifest) nor with existing files on
 * disk, appending `-1`, `-2`… before the extension as needed.
 */
export const resolveAvailableRelPath = async (
  root: FileSystemDirectoryHandle,
  displayName: string,
  takenPaths: Set<string>,
): Promise<string> => {
  const dotIndex = displayName.lastIndexOf(".");
  const base = dotIndex > 0 ? displayName.slice(0, dotIndex) : displayName;
  const extension = dotIndex > 0 ? displayName.slice(dotIndex) : "";

  for (let attempt = 0; ; attempt++) {
    const candidate =
      attempt === 0 ? `${base}${extension}` : `${base}-${attempt}${extension}`;
    if (takenPaths.has(candidate)) {
      continue;
    }
    try {
      // resolves only when the file already exists on disk
      await getFileHandleByRelPath(root, candidate);
    } catch {
      return candidate;
    }
  }
};

/** strips characters that are illegal in file names on common platforms */
export const sanitizeFileName = (name: string): string => {
  const sanitized = name
    .replace(/[<>:"/\\|?*]/g, "_")
    // strip C0 control characters
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, "_")
    // trailing dots/spaces are illegal on Windows
    .replace(/[. ]+$/, "")
    .trim();
  return sanitized || "untitled";
};
