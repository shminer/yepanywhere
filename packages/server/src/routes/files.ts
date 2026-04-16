import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, normalize, resolve, sep } from "node:path";
import {
  type FileContentResponse,
  type FileMetadata,
  type PatchHunk,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { computeEditAugment } from "../augments/edit-augments.js";
import { renderMarkdownToHtml } from "../augments/markdown-augments.js";
import { highlightFile } from "../highlighting/index.js";
import { getMimeType, isTextFilePath } from "../lib/mime.js";
import type { ProjectScanner } from "../projects/scanner.js";

export interface FilesDeps {
  scanner: ProjectScanner;
}

/** Maximum file size to include content inline (1MB) */
const MAX_INLINE_SIZE = 1024 * 1024;

/**
 * Validate and resolve file path, preventing directory traversal.
 * Returns null if the path is invalid or escapes the project root.
 */
function resolveFilePath(
  projectRoot: string,
  relativePath: string,
): string | null {
  // Normalize the path to handle . and ..
  const normalized = normalize(relativePath);

  // Reject absolute paths
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    return null;
  }

  // Reject paths that try to escape (after normalization, should not start with ..)
  if (normalized.startsWith("..")) {
    return null;
  }

  // Resolve to absolute path
  const resolved = resolve(projectRoot, normalized);

  // Verify the resolved path is still within project root
  const normalizedRoot = resolve(projectRoot);
  if (
    !resolved.startsWith(`${normalizedRoot}${sep}`) &&
    resolved !== normalizedRoot
  ) {
    return null;
  }

  return resolved;
}

export function createFilesRoutes(deps: FilesDeps): Hono {
  const routes = new Hono();

  /**
   * GET /api/projects/:projectId/files
   * Get file metadata and content.
   * Query params:
   *   - path: relative path to file (required)
   *   - highlight: if "true", include syntax-highlighted HTML
   */
  routes.get("/:projectId/files", async (c) => {
    const projectId = c.req.param("projectId");
    const relativePath = c.req.query("path");
    const highlight = c.req.query("highlight") === "true";

    // Validate project ID format
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Validate path parameter
    if (!relativePath) {
      return c.json({ error: "Missing path parameter" }, 400);
    }

    // Get project
    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    // Get the project's working directory
    const projectRoot = project.path;

    // Resolve and validate file path
    const filePath = resolveFilePath(projectRoot, relativePath);
    if (!filePath) {
      return c.json({ error: "Invalid file path" }, 400);
    }

    // Check file exists and get stats
    let stats: Stats;
    try {
      stats = await stat(filePath);
    } catch {
      return c.json({ error: "File not found" }, 404);
    }

    // Must be a file, not a directory
    if (!stats.isFile()) {
      return c.json({ error: "Path is not a file" }, 400);
    }

    const mimeType = getMimeType(filePath);
    const isText = isTextFilePath(filePath);

    const metadata: FileMetadata = {
      path: relativePath,
      size: stats.size,
      mimeType,
      isText,
    };

    // Build raw URL
    const rawUrl = `/api/projects/${projectId}/files/raw?path=${encodeURIComponent(relativePath)}`;

    const response: FileContentResponse = {
      metadata,
      rawUrl,
    };

    // For text files under size limit, include content
    if (isText && stats.size <= MAX_INLINE_SIZE) {
      try {
        const content = await readFile(filePath, "utf-8");
        response.content = content;

        // Add syntax highlighting if requested
        if (highlight) {
          const result = await highlightFile(content, relativePath);
          if (result) {
            response.highlightedHtml = result.html;
            response.highlightedLanguage = result.language;
            response.highlightedTruncated = result.truncated;
          }

          // Render markdown preview for .md files
          const ext = extname(relativePath).toLowerCase();
          if (ext === ".md" || ext === ".markdown") {
            try {
              response.renderedMarkdownHtml =
                await renderMarkdownToHtml(content);
            } catch {
              // Ignore markdown rendering errors
            }
          }
        }
      } catch {
        // If we can't read as text, just omit content
      }
    }

    return c.json(response);
  });

  /**
   * GET /api/projects/:projectId/files/raw
   * Get raw file content with appropriate Content-Type.
   * Query params:
   *   - path: relative path to file (required)
   *   - download: if "true", set Content-Disposition to attachment
   */
  routes.get("/:projectId/files/raw", async (c) => {
    const projectId = c.req.param("projectId");
    const relativePath = c.req.query("path");
    const download = c.req.query("download") === "true";

    // Validate project ID format
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Validate path parameter
    if (!relativePath) {
      return c.json({ error: "Missing path parameter" }, 400);
    }

    // Get project
    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    // Get the project's working directory
    const projectRoot = project.path;

    // Resolve and validate file path
    const filePath = resolveFilePath(projectRoot, relativePath);
    if (!filePath) {
      return c.json({ error: "Invalid file path" }, 400);
    }

    // Check file exists and get stats
    let stats: Stats;
    try {
      stats = await stat(filePath);
    } catch {
      return c.json({ error: "File not found" }, 404);
    }

    // Must be a file, not a directory
    if (!stats.isFile()) {
      return c.json({ error: "Path is not a file" }, 400);
    }

    // Read file content
    let content: Buffer;
    try {
      content = await readFile(filePath);
    } catch {
      return c.json({ error: "Failed to read file" }, 500);
    }

    const mimeType = getMimeType(filePath);
    const fileName = relativePath.split("/").pop() || "file";

    // Set headers
    const headers: Record<string, string> = {
      "Content-Type": mimeType,
      "Content-Length": String(content.length),
    };

    if (download) {
      headers["Content-Disposition"] = `attachment; filename="${fileName}"`;
    } else {
      headers["Content-Disposition"] = `inline; filename="${fileName}"`;
    }

    // Convert Buffer to Uint8Array for Response compatibility
    return new Response(new Uint8Array(content), { headers });
  });

  /**
   * POST /api/projects/:projectId/diff/expand
   * Compute an expanded diff with full file context.
   *
   * Uses originalFile from the SDK's Edit tool result directly - the SDK never
   * truncates this field (verified up to 150KB+ files).
   *
   * Body:
   *   - filePath: path to file (for syntax highlighting detection)
   *   - oldString: the original text being replaced
   *   - newString: the new text to insert
   *   - originalFile: complete file content from SDK Edit result
   */
  routes.post("/:projectId/diff/expand", async (c) => {
    // Parse body
    let body: {
      filePath: string;
      oldString: string;
      newString: string;
      originalFile: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { filePath, oldString, newString, originalFile } = body;

    if (
      !filePath ||
      typeof oldString !== "string" ||
      typeof newString !== "string" ||
      typeof originalFile !== "string"
    ) {
      return c.json(
        {
          error:
            "Missing required fields: filePath, oldString, newString, originalFile",
        },
        400,
      );
    }

    // Compute the new file content by applying the edit
    const newFullContent = originalFile.replace(oldString, newString);

    // Compute augment with large context (entire file)
    const augment = await computeEditAugment(
      "expand",
      {
        file_path: filePath,
        old_string: originalFile,
        new_string: newFullContent,
      },
      999999, // Full file context
    );

    return c.json({
      structuredPatch: augment.structuredPatch as PatchHunk[],
      diffHtml: augment.diffHtml,
    });
  });

  return routes;
}
