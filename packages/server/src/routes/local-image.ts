import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { getMimeType } from "../lib/mime.js";

interface LocalImageDeps {
  allowedPaths: string[];
  getAllowedPaths?: () => Promise<string[]>;
}

/**
 * Remove a markdown-style line anchor from a local file path.
 */
export function stripLocalPathFragment(filePath: string): string {
  const trimmed = filePath.trim();
  const hashIndex = trimmed.indexOf("#");
  return hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex);
}

/**
 * Normalize an incoming local file path for the current platform.
 * Accepts Windows drive-letter paths with or without a leading slash.
 */
export function normalizeRequestedLocalPath(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const strippedPath = stripLocalPathFragment(filePath);
  if (!strippedPath) {
    return null;
  }

  if (platform === "win32") {
    if (/^\/[a-zA-Z]:[\\/]/.test(strippedPath)) {
      return strippedPath.slice(1);
    }
    if (/^[a-zA-Z]:[\\/]/.test(strippedPath)) {
      return strippedPath;
    }
  }

  if (strippedPath.startsWith("/")) {
    return strippedPath;
  }

  return null;
}

function normalizePathForComparison(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized =
    platform === "win32"
      ? path.win32.normalize(filePath)
      : path.posix.normalize(filePath);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Check whether a resolved file path is under one of the allowed roots.
 */
export function isPathWithinAllowedRoots(
  filePath: string,
  allowedRoots: string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalizedPath = normalizePathForComparison(filePath, platform);

  return allowedRoots.some((allowedRoot) => {
    const normalizedRoot = normalizePathForComparison(allowedRoot, platform);
    const relativePath = pathApi.relative(normalizedRoot, normalizedPath);
    return (
      relativePath === "" ||
      (!relativePath.startsWith("..") && !pathApi.isAbsolute(relativePath))
    );
  });
}

/**
 * Create routes for serving local files from allowed paths.
 *
 * Security: Only serves files that:
 * 1. Resolve (after symlink resolution) to a path under an allowed prefix
 * 2. Are regular files (not directories, devices, etc.)
 */
export function createLocalImageRoutes(deps: LocalImageDeps) {
  const routes = new Hono();

  async function resolveAllowedPaths(paths: string[]): Promise<string[]> {
    const uniquePaths = Array.from(new Set(paths));
    return Promise.all(
      uniquePaths.map(async (p) => {
        try {
          return await realpath(p);
        } catch {
          return p;
        }
      }),
    );
  }

  // Resolve static allowed paths once so symlinks like /tmp -> /private/tmp work.
  let resolvedStaticAllowedPaths: string[] | null = null;
  async function getAllowedPaths(): Promise<string[]> {
    if (!resolvedStaticAllowedPaths) {
      resolvedStaticAllowedPaths = await resolveAllowedPaths(deps.allowedPaths);
    }

    if (!deps.getAllowedPaths) {
      return resolvedStaticAllowedPaths;
    }

    const dynamicPaths = await deps.getAllowedPaths();
    return resolveAllowedPaths([
      ...resolvedStaticAllowedPaths,
      ...dynamicPaths,
    ]);
  }

  routes.get("/", async (c) => {
    const rawFilePath = c.req.query("path");
    if (!rawFilePath) {
      return c.json({ error: "Missing path parameter" }, 400);
    }

    const filePath = normalizeRequestedLocalPath(rawFilePath);
    if (!filePath) {
      return c.json({ error: "Path must be absolute" }, 400);
    }

    const contentType = getMimeType(filePath);

    // Resolve symlinks to get the real path
    let resolvedPath: string;
    try {
      resolvedPath = await realpath(filePath);
    } catch {
      return c.json({ error: "File not found" }, 404);
    }

    // Check resolved path against resolved allowed prefixes
    const allowed = await getAllowedPaths();
    const isAllowed = isPathWithinAllowedRoots(resolvedPath, allowed);
    if (!isAllowed) {
      return c.json({ error: "Path not in allowed directories" }, 403);
    }

    try {
      const stats = await stat(resolvedPath);
      if (!stats.isFile()) {
        return c.json({ error: "Not a file" }, 404);
      }

      c.header("Content-Type", contentType);
      c.header("Content-Length", stats.size.toString());
      c.header("Cache-Control", "private, max-age=3600");
      c.header(
        "Content-Disposition",
        `inline; filename="${path.basename(resolvedPath)}"`,
      );

      return stream(c, async (s) => {
        const readable = createReadStream(resolvedPath);
        for await (const chunk of readable) {
          await s.write(chunk);
        }
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ error: "File not found" }, 404);
      }
      console.error("[LocalImage] Error serving file:", err);
      return c.json({ error: "Internal error" }, 500);
    }
  });

  return routes;
}
