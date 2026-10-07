/**
 * Decode an image blob to get its natural dimensions. Kept in its own module
 * so geometry tests can mock it out (jsdom cannot decode images).
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

export const getImageBlobDimensions = (blob: Blob): Promise<ImageDimensions> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("could not decode image blob"));
    };
    image.src = url;
  });
