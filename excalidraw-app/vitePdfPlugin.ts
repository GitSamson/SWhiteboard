/**
 * Dev-server middleware that rasterizes PDF pages server-side via the
 * pdfjs-dist legacy build (Node) + @napi-rs/canvas, so pdf elements render
 * through the regular static canvas pipeline instead of a DOM overlay.
 *
 * Only available on the vite dev server — the production build is statically
 * hosted, so POST /api/pdf-open and GET /api/pdf-page do not exist there and
 * pdf elements keep showing their placeholder.
 *
 * Endpoints:
 *   POST /api/pdf-open            body = raw PDF bytes
 *         → JSON { hash, pageCount, pages: [{ width, height }] }
 *         The source is cached on disk under os.tmpdir()/swhiteboard-pdfcache
 *         keyed by its SHA-1 (same scheme as generateIdFromFile), so repeat
 *         opens of the same document skip parsing.
 *   GET /api/pdf-page?hash=<sha1>&page=<n>&width=<px>
 *         → image/webp (quality 90) of the page rasterized at the given
 *         width (default 1600px). Pages are cached on disk per (hash, page,
 *         width).
 */

import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { mkdir, rename, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";

import type { Plugin } from "vite";

/** per-page viewport size at scale 1, as returned by /api/pdf-open */
export interface PdfOpenPage {
  width: number;
  height: number;
}

export interface PdfOpenInfo {
  hash: string;
  pageCount: number;
  pages: PdfOpenPage[];
}

export class PdfRequestError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = "PdfRequestError";
  }
}

/** hex SHA-1 of the PDF bytes — matches generateIdFromFile's scheme */
export const hashPdfBytes = (bytes: Uint8Array): string =>
  createHash("sha1").update(bytes).digest("hex");

/** default page rasterization width when the query omits it */
export const DEFAULT_PAGE_WIDTH = 1200;
/** webp encoding quality */
export const PAGE_QUALITY = 80;

/** parse & validate the /api/pdf-page query string (unit-tested) */
export const parsePdfPageQuery = (
  search: string,
): {
  hash: string;
  page: number;
  width: number;
} => {
  const params = new URLSearchParams(search);
  const hash = params.get("hash") ?? "";
  if (!/^[0-9a-f]{40}$/.test(hash)) {
    throw new PdfRequestError(400, "invalid hash");
  }
  const page = Number(params.get("page"));
  if (!Number.isInteger(page) || page < 1) {
    throw new PdfRequestError(400, "invalid page");
  }
  const widthParam = params.get("width");
  const width = widthParam == null ? DEFAULT_PAGE_WIDTH : Number(widthParam);
  if (!Number.isInteger(width) || width < 16 || width > 8192) {
    throw new PdfRequestError(400, "invalid width");
  }
  return { hash, page, width };
};

/** on-disk layout of the pdf cache (unit-tested) */
export const pdfCachePaths = (
  cacheDir: string,
  hash: string,
): {
  pdfPath: string;
  infoPath: string;
  pagePath: (page: number, width: number) => string;
} => ({
  pdfPath: path.join(cacheDir, `${hash}.pdf`),
  infoPath: path.join(cacheDir, `${hash}.json`),
  pagePath: (page: number, width: number) =>
    path.join(cacheDir, `${hash}-p${page}-w${width}.webp`),
});

type PdfjsDocument = {
  numPages: number;
  getPage: (page: number) => Promise<{
    getViewport: (opts: { scale: number }) => { width: number; height: number };
    render: (opts: { canvas: unknown; viewport: unknown }) => {
      promise: Promise<void>;
    };
  }>;
};

let pdfjsModule: Promise<
  typeof import("pdfjs-dist/legacy/build/pdf.mjs")
> | null = null;
const loadPdfjs = () => {
  if (!pdfjsModule) {
    pdfjsModule = import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjsModule;
};

const readBody = (req: NodeJS.ReadableStream): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
  });

/** atomic write: temp file in the same dir, then rename over the target */
const writeFileAtomic = async (
  targetPath: string,
  data: Uint8Array,
): Promise<void> => {
  const tmp = `${targetPath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, targetPath);
};

const cacheDir = () => path.join(os.tmpdir(), "swhiteboard-pdfcache");

/** in-flight opens deduped per hash */
const openPromises = new Map<string, Promise<PdfOpenInfo>>();

const openPdf = async (
  bytes: Uint8Array,
  dir: string,
): Promise<PdfOpenInfo> => {
  const hash = hashPdfBytes(bytes);
  const existing = openPromises.get(hash);
  if (existing) {
    return existing;
  }
  const promise = (async () => {
    const { pdfPath, infoPath } = pdfCachePaths(dir, hash);
    await mkdir(dir, { recursive: true });

    if (existsSync(pdfPath) && existsSync(infoPath)) {
      return JSON.parse(readFileSync(infoPath, "utf8")) as PdfOpenInfo;
    }

    await writeFileAtomic(pdfPath, bytes);

    const pdfjs = await loadPdfjs();
    const task = pdfjs.getDocument({
      data: bytes,
      // render to bitmaps only; we don't need the embedded fonts as faces
      disableFontFace: true,
    });
    const pdf = (await task.promise) as unknown as PdfjsDocument;
    try {
      const pages: PdfOpenPage[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1 });
        pages.push({ width: viewport.width, height: viewport.height });
      }
      const info: PdfOpenInfo = { hash, pageCount: pdf.numPages, pages };
      await writeFileAtomic(
        infoPath,
        new TextEncoder().encode(JSON.stringify(info)),
      );
      return info;
    } finally {
      void task.destroy();
    }
  })();
  openPromises.set(hash, promise);
  try {
    return await promise;
  } finally {
    openPromises.delete(hash);
  }
};

const renderPageToWebp = async (
  hash: string,
  pageNumber: number,
  width: number,
  dir: string,
): Promise<Uint8Array> => {
  const { pdfPath, pagePath } = pdfCachePaths(dir, hash);
  const cachedPath = pagePath(pageNumber, width);
  if (existsSync(cachedPath)) {
    return new Uint8Array(readFileSync(cachedPath));
  }
  if (!existsSync(pdfPath)) {
    throw new PdfRequestError(
      404,
      "unknown hash — POST the PDF to /api/pdf-open first",
    );
  }

  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    url: `file://${pdfPath.split("\\").join("/")}`,
    disableFontFace: true,
  });
  const pdf = (await task.promise) as unknown as PdfjsDocument;
  try {
    if (pageNumber > pdf.numPages) {
      throw new PdfRequestError(400, `page out of range (1..${pdf.numPages})`);
    }
    const page = await pdf.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / baseViewport.width });
    const { createCanvas } = await import("@napi-rs/canvas");
    const canvas = createCanvas(
      Math.max(1, Math.ceil(viewport.width)),
      Math.max(1, Math.ceil(viewport.height)),
    );
    await page.render({ canvas, viewport }).promise;
    const encoded = (await canvas.encode(
      "webp",
      PAGE_QUALITY,
    )) as unknown as Uint8Array;
    await writeFileAtomic(cachedPath, encoded);
    return encoded;
  } finally {
    void task.destroy();
  }
};

const sendJson = (
  res: NodeJS.WritableStream & { statusCode: number },
  data: unknown,
) => {
  const body = JSON.stringify(data);
  res.statusCode = 200;
  (res as any).setHeader?.("Content-Type", "application/json");
  (res as any).setHeader?.("Content-Length", Buffer.byteLength(body));
  res.end(body);
};

export const pdfPagesPlugin = (): Plugin => ({
  name: "swhiteboard-pdf-pages",
  configureServer(server) {
    server.middlewares.use("/api/pdf-open", (req, res) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end("POST only");
        return;
      }
      void (async () => {
        try {
          const bytes = await readBody(req);
          if (bytes.length === 0) {
            throw new PdfRequestError(400, "empty body");
          }
          const info = await openPdf(bytes, cacheDir());
          sendJson(res, info);
        } catch (error) {
          const statusCode =
            error instanceof PdfRequestError ? error.statusCode : 500;
          res.statusCode = statusCode;
          res.end(error instanceof Error ? error.message : "pdf-open failed");
        }
      })();
    });

    server.middlewares.use("/api/pdf-page", (req, res) => {
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.end("GET only");
        return;
      }
      void (async () => {
        try {
          // req.url SHOULD be the remainder after the mount point ("?…"),
          // but be tolerant of receiving the full path (strip everything
          // up to the first "?")
          const raw = req.url ?? "";
          const search = raw.includes("?")
            ? raw.slice(raw.indexOf("?") + 1)
            : raw.replace(/^\?/, "");
          const query = parsePdfPageQuery(search);
          const webp = await renderPageToWebp(
            query.hash,
            query.page,
            query.width,
            cacheDir(),
          );
          res.statusCode = 200;
          res.setHeader("Content-Type", "image/webp");
          res.setHeader("Content-Length", webp.length);
          res.end(webp);
        } catch (error) {
          const statusCode =
            error instanceof PdfRequestError ? error.statusCode : 500;
          res.statusCode = statusCode;
          res.end(error instanceof Error ? error.message : "pdf-page failed");
        }
      })();
    });
  },
});
