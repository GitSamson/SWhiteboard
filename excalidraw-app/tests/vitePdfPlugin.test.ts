/**
 * Unit tests for the pure (spawn/pdfjs-free) helpers of the PDF
 * rasterization dev-server plugin. Actual parsing/rendering is not covered —
 * it needs a real pdfjs + canvas environment.
 */

import path from "path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_WIDTH,
  hashPdfBytes,
  parsePdfPageQuery,
  pdfCachePaths,
  PdfRequestError,
} from "../vitePdfPlugin";

const VALID_HASH = "a".repeat(40);

describe("hashPdfBytes", () => {
  it("produces the hex SHA-1 of the bytes (generateIdFromFile scheme)", () => {
    // printf 'hello pdf' | sha1sum
    expect(hashPdfBytes(new TextEncoder().encode("hello pdf"))).toBe(
      "fb39115ff2e57462aa671d6609a53fdcb4cb3407",
    );
  });
});

describe("parsePdfPageQuery", () => {
  it("parses hash, page and width", () => {
    expect(parsePdfPageQuery(`hash=${VALID_HASH}&page=3&width=1440`)).toEqual({
      hash: VALID_HASH,
      page: 3,
      width: 1440,
    });
  });

  it("defaults the width", () => {
    expect(parsePdfPageQuery(`hash=${VALID_HASH}&page=1`).width).toBe(
      DEFAULT_PAGE_WIDTH,
    );
  });

  it("rejects malformed hashes", () => {
    for (const hash of ["", "xyz", "a".repeat(39), "A".repeat(40)]) {
      expect(() => parsePdfPageQuery(`hash=${hash}&page=1`)).toThrow(
        PdfRequestError,
      );
    }
  });

  it("rejects out-of-range or non-integer pages", () => {
    for (const page of ["0", "-1", "1.5", "abc", ""]) {
      expect(() =>
        parsePdfPageQuery(`hash=${VALID_HASH}&page=${page}`),
      ).toThrow(PdfRequestError);
    }
  });

  it("rejects out-of-range or non-integer widths", () => {
    for (const width of ["0", "15", "8193", "1.5", "abc"]) {
      expect(() =>
        parsePdfPageQuery(`hash=${VALID_HASH}&page=1&width=${width}`),
      ).toThrow(PdfRequestError);
    }
  });

  it("exposes the status code on the error", () => {
    try {
      parsePdfPageQuery("hash=nope&page=1");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PdfRequestError);
      expect((error as PdfRequestError).statusCode).toBe(400);
    }
  });
});

describe("pdfCachePaths", () => {
  it("maps hash/pages onto stable cache file names", () => {
    const dir = path.join("tmp", "pdfcache");
    const paths = pdfCachePaths(dir, VALID_HASH);
    expect(paths.pdfPath).toBe(path.join(dir, `${VALID_HASH}.pdf`));
    expect(paths.infoPath).toBe(path.join(dir, `${VALID_HASH}.json`));
    expect(paths.pagePath(2, 1440)).toBe(
      path.join(dir, `${VALID_HASH}-p2-w1440.webp`),
    );
  });
});
