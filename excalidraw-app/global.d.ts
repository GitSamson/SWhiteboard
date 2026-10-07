import "@excalidraw/excalidraw/global";
import "@excalidraw/excalidraw/css";

interface Window {
  __EXCALIDRAW_SHA__: string | undefined;
}

declare module "ffmpeg-static" {
  /** absolute path to the ffmpeg executable, or null if unavailable */
  const path: string | null;
  export default path;
}
