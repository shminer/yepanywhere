import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLocalImageRoutes,
  isPathWithinAllowedRoots,
  normalizeRequestedLocalPath,
} from "../../src/routes/local-image.js";

describe("Local image routes", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "yep-local-image-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("serves files from the managed uploads directory", async () => {
    const uploadsDir = path.join(tempDir, "uploads");
    const sessionDir = path.join(
      uploadsDir,
      "encoded-project-path",
      "session-123",
    );
    await mkdir(sessionDir, { recursive: true });

    const filePath = path.join(sessionDir, "screenshot 9.10.56 AM.png");
    await writeFile(filePath, "png-bytes");

    const routes = createLocalImageRoutes({
      allowedPaths: [uploadsDir],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await response.text()).toBe("png-bytes");
  });

  it("rejects files outside the allowed directories", async () => {
    const uploadsDir = path.join(tempDir, "uploads");
    const otherDir = path.join(tempDir, "other");
    await mkdir(otherDir, { recursive: true });

    const filePath = path.join(otherDir, "outside.png");
    await writeFile(filePath, "png-bytes");

    const routes = createLocalImageRoutes({
      allowedPaths: [uploadsDir],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Path not in allowed directories",
    });
  });

  it("serves files from dynamically allowed directories", async () => {
    const projectDir = path.join(tempDir, "project");
    await mkdir(projectDir, { recursive: true });

    const filePath = path.join(projectDir, "Dockerfile");
    await writeFile(filePath, "FROM node:20\n");

    const routes = createLocalImageRoutes({
      allowedPaths: [],
      getAllowedPaths: async () => [projectDir],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/x-dockerfile");
    expect(await response.text()).toBe("FROM node:20\n");
  });

  it("serves non-media files and ignores markdown line anchors", async () => {
    const uploadsDir = path.join(tempDir, "uploads");
    const sessionDir = path.join(uploadsDir, "encoded-project-path", "session");
    await mkdir(sessionDir, { recursive: true });

    const filePath = path.join(sessionDir, "main.c");
    await writeFile(filePath, "int main(void) { return 0; }\n");

    const routes = createLocalImageRoutes({
      allowedPaths: [uploadsDir],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(`${filePath}#L840`)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/x-c");
    expect(await response.text()).toBe("int main(void) { return 0; }\n");
  });

  it("normalizes Windows drive-letter paths with a leading slash", () => {
    expect(
      normalizeRequestedLocalPath(
        "/C:/workspace/project/src/main.c#L840",
        "win32",
      ),
    ).toBe("C:/workspace/project/src/main.c");
  });

  it("matches allowed Windows roots case-insensitively", () => {
    expect(
      isPathWithinAllowedRoots(
        "C:\\workspace\\project\\src\\payload\\main.c",
        ["c:/workspace/project"],
        "win32",
      ),
    ).toBe(true);
  });
});
