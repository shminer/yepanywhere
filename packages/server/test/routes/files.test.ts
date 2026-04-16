import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import { createFilesRoutes } from "../../src/routes/files.js";

describe("Files routes", () => {
  let tempDir: string;
  let projectPath: string;
  let projectId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "yep-files-route-"));
    projectPath = path.join(tempDir, "project");
    projectId = encodeProjectId(projectPath);
    await mkdir(projectPath, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns utf-8 content type for raw text files with Chinese content", async () => {
    await writeFile(path.join(projectPath, "notes.txt"), "中文内容\n");

    const routes = createFilesRoutes({
      scanner: {
        getProject: async (id: string) =>
          id === projectId
            ? {
                id: projectId,
                path: projectPath,
                name: "project",
                sessionCount: 0,
                sessionDir: path.join(tempDir, "sessions"),
                activeOwnedCount: 0,
                activeExternalCount: 0,
                lastActivity: null,
                provider: "claude",
              }
            : null,
      } as never,
    });

    const response = await routes.request(
      `/${projectId}/files/raw?path=${encodeURIComponent("notes.txt")}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(await response.text()).toBe("中文内容\n");
  });
});
