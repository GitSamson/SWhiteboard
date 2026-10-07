/**
 * Dev-server middleware that transcodes video (e.g. HEVC/H.265) to H.264 mp4
 * via ffmpeg-static, so browsers that can't decode HEVC can play imported
 * videos after a server-side round trip.
 *
 * Only available on the vite dev server — the production build is statically
 * hosted, so POST /api/transcode-video does not exist there and the client
 * falls back to the "unsupported codec" hint.
 */

import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { createWriteStream, readFileSync, rmSync } from "fs";
import os from "os";
import path from "path";

import ffmpegPath from "ffmpeg-static";

import type { Plugin } from "vite";

/** ffmpeg CLI arguments for one transcode run (unit-tested) */
export const buildFfmpegArgs = (
  inputPath: string,
  outputPath: string,
  scale = true,
): string[] => [
  "-y",
  "-i",
  inputPath,
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-crf",
  "23",
  // width capped at 1920 (even), height auto to preserve aspect ratio;
  // `scale: false` drops the filter entirely (fallback for ffmpeg builds
  // that reject the quoted expression)
  ...(scale ? (["-vf", "scale='min(1920,iw)':-2"] as const) : []),
  "-c:a",
  "aac",
  "-b:a",
  "128k",
  "-movflags",
  "+faststart",
  outputPath,
];

/** run ffmpeg; resolves on exit code 0, rejects with the tail of stderr */
const runFfmpeg = (args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error("ffmpeg binary is not available"));
      return;
    }
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 64 * 1024) {
        stderr = stderr.slice(-32 * 1024);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `ffmpeg exited with code ${code}: ${stderr.split("\n").pop()}`,
          ),
        );
      }
    });
  });

const cleanup = (...paths: string[]) => {
  for (const p of paths) {
    try {
      rmSync(p, { force: true });
    } catch {
      // best effort
    }
  }
};

export const transcodeVideoPlugin = (): Plugin => ({
  name: "swhiteboard-transcode-video",
  configureServer(server) {
    server.middlewares.use("/api/transcode-video", (req, res) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end("POST only");
        return;
      }

      const id = randomBytes(8).toString("hex");
      const inputPath = path.join(os.tmpdir(), `swhiteboard-in-${id}.bin`);
      const outputPath = path.join(os.tmpdir(), `swhiteboard-out-${id}.mp4`);
      const outStream = createWriteStream(inputPath);
      req.pipe(outStream);
      req.on("error", (error) => {
        cleanup(inputPath);
        res.statusCode = 500;
        res.end(`request error: ${error.message}`);
      });
      outStream.on("error", (error) => {
        cleanup(inputPath);
        res.statusCode = 500;
        res.end(`write error: ${error.message}`);
      });
      outStream.on("finish", () => {
        void (async () => {
          try {
            try {
              await runFfmpeg(buildFfmpegArgs(inputPath, outputPath));
            } catch (error) {
              // some ffmpeg builds choke on the quoted scale expression —
              // retry without scaling before giving up
              await runFfmpeg(buildFfmpegArgs(inputPath, outputPath, false));
            }
            const mp4 = readFileSync(outputPath);
            res.statusCode = 200;
            res.setHeader("Content-Type", "video/mp4");
            res.setHeader("Content-Length", mp4.length);
            res.end(mp4);
          } catch (error: any) {
            res.statusCode = 500;
            res.end(error?.message ?? "transcode failed");
          } finally {
            cleanup(inputPath, outputPath);
          }
        })();
      });
    });
  },
});
