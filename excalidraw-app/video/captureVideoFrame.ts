/**
 * Capture the current frame of a video element as a JPEG blob, with a
 * timecode burned into the top-right corner. Kept as a standalone helper so
 * the canvas work can be unit-tested with a mocked 2d context.
 */

/**
 * Burn a timecode label onto a canvas context, top-right corner, black
 * background with white text.
 */
export const burnTimecode = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  timecode: string,
): void => {
  const fontSize = Math.max(10, Math.round(height / 20));
  const padding = 4;
  context.save();
  context.font = `${fontSize}px monospace`;
  const textWidth = context.measureText(timecode).width;
  const rectWidth = textWidth + padding * 2;
  const rectHeight = fontSize + padding * 2;
  const x = width - rectWidth - padding;
  const y = padding;
  context.fillStyle = "#000";
  context.fillRect(x, y, rectWidth, rectHeight);
  context.fillStyle = "#fff";
  context.textBaseline = "top";
  context.fillText(timecode, x + padding, y + padding);
  context.restore();
};

/**
 * Draw the video's current frame at full native resolution onto an offscreen
 * canvas, burn the given timecode into it, and encode as JPEG.
 */
export const captureVideoFrame = async (
  video: HTMLVideoElement,
  timecode: string,
): Promise<Blob> => {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("2d canvas context unavailable");
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  burnTimecode(context, canvas.width, canvas.height, timecode);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.92),
  );
  if (!blob) {
    throw new Error("canvas.toBlob failed");
  }
  return blob;
};
