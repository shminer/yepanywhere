import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";

function encodeProjectDirName(projectPath: string): string {
  return projectPath.replace(/[/\\:]/g, "-");
}

function toLocalImageRequestPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return process.platform === "win32" ? `/${normalized}` : normalized;
}

describe("Local image API", () => {
  let mockSdk: MockClaudeSDK;
  let testDir: string;
  let projectsDir: string;
  let projectPath: string;
  let sourceFilePath: string;

  beforeEach(async () => {
    mockSdk = new MockClaudeSDK();
    testDir = join(tmpdir(), `claude-test-${randomUUID()}`);
    projectsDir = join(testDir, "sessions");
    projectPath = join(testDir, "battcontrol");
    sourceFilePath = join(projectPath, "src", "cloudauth", "cloudauth.c");

    await mkdir(join(projectPath, "src", "cloudauth"), { recursive: true });
    await writeFile(
      sourceFilePath,
      '#include "cloudauth.h"\n\nint auth_main(void) { return 0; }\n',
    );

    const sessionDir = join(projectsDir, encodeProjectDirName(projectPath));
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "sess-existing.jsonl"),
      `{"type":"user","cwd":"${projectPath.replaceAll("\\", "\\\\")}","message":{"content":"Hello"}}\n`,
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("serves scanned project files even without static allowed image paths", async () => {
    const { app } = createApp({
      sdk: mockSdk,
      projectsDir,
    });

    const requestPath = `${toLocalImageRequestPath(sourceFilePath)}#L664`;
    const response = await app.request(
      `/api/local-image?path=${encodeURIComponent(requestPath)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/x-c");
    expect(await response.text()).toBe(
      '#include "cloudauth.h"\n\nint auth_main(void) { return 0; }\n',
    );
  });
});
