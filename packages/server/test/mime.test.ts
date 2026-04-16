import { describe, expect, it } from "vitest";
import { getMimeType, isTextFilePath } from "../src/lib/mime.js";

describe("mime helpers", () => {
  describe("getMimeType", () => {
    it.each([
      ["src/app.mts", "text/typescript"],
      ["src/app.cts", "text/typescript"],
      ["src/native/file.cxx", "text/x-c++"],
      ["src/native/file.hxx", "text/x-c++"],
      ["src/script.kts", "text/x-kotlin"],
      ["schema/service.graphqls", "text/x-graphql"],
      ["logs/server.log", "text/plain"],
      ["locks/pnpm.lock", "text/plain"],
      ["data/report.csv", "text/csv"],
      ["msbuild/Directory.Build.props", "application/xml"],
      ["Dockerfile", "text/x-dockerfile"],
      ["Makefile", "text/x-makefile"],
      [".env", "text/plain"],
      [".env.local", "text/plain"],
      [".prettierrc", "application/json"],
      ["image.svg", "image/svg+xml"],
      ["archive.bin", "application/octet-stream"],
    ])("returns %s for %s", (filePath, expectedMime) => {
      expect(getMimeType(filePath)).toBe(expectedMime);
    });
  });

  describe("isTextFilePath", () => {
    it.each([
      ["src/app.mts", true],
      ["src/app.cts", true],
      ["src/native/file.cxx", true],
      ["src/native/file.hxx", true],
      ["src/script.kts", true],
      ["schema/service.graphqls", true],
      ["logs/server.log", true],
      ["locks/pnpm.lock", true],
      ["data/report.csv", true],
      ["msbuild/Directory.Build.props", true],
      ["Dockerfile", true],
      ["Makefile", true],
      [".env", true],
      [".env.local", true],
      [".prettierrc", true],
      ["image.svg", true],
      ["image.png", false],
      ["archive.zip", false],
    ])("returns text=%s for %s", (filePath, expectedText) => {
      expect(isTextFilePath(filePath)).toBe(expectedText);
    });
  });
});
