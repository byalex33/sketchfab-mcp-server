import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SketchfabApiClient, errorMessage, type DownloadFormat } from "./client.js";
import { chooseFormat, downloadToDisk, safeFileStem, DEFAULT_DOWNLOAD_DIR } from "./download.js";
import {
  attributionLine,
  formatBytes,
  formatModelDetails,
  formatSearchHit,
  pickThumbnail,
  summarizeModel,
} from "./format.js";

export const SERVER_NAME = "sketchfab-mcp-server";
export const SERVER_VERSION = "1.1.0";

const LICENSES = ["by", "by-sa", "by-nd", "by-nc", "by-nc-sa", "by-nc-nd", "cc0", "free-st", "st", "ed"] as const;
const SORTS = ["-likeCount", "-viewCount", "-publishedAt", "-processedAt"] as const;
const FORMATS = ["gltf", "glb", "usdz", "source"] as const;

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

function failure(prefix: string, error: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: `${prefix}: ${errorMessage(error)}` }] };
}

async function fetchThumbnailBlock(
  client: SketchfabApiClient,
  url: string | undefined,
): Promise<CallToolResult["content"][number] | undefined> {
  if (!url) return undefined;
  try {
    const response = await client.fetchBinary(url, 15_000);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > 1_000_000) return undefined;
    const mimeType = response.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    return { type: "image", data: data.toString("base64"), mimeType };
  } catch {
    return undefined; // A thumbnail is a nice-to-have; never fail the tool for it.
  }
}

export function createServer(client: SketchfabApiClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "sketchfab-search",
    {
      title: "Search Sketchfab models",
      description:
        "Search Sketchfab for 3D models. Returns IDs plus license, face count and downloadability for each hit. " +
        "Use `cursor` from a previous result to get the next page. Use sketchfab-list-categories for valid category slugs. " +
        "No API key is needed.",
      inputSchema: {
        query: z.string().optional().describe('Free-text search, e.g. "low poly car"'),
        tags: z.array(z.string()).optional().describe('Tag slugs, e.g. ["rigged", "pbr"]'),
        categories: z
          .array(z.string())
          .optional()
          .describe('Category slugs, e.g. ["cars-vehicles", "characters-creatures"]'),
        downloadable: z.boolean().optional().describe("true = only models that can be downloaded"),
        animated: z.boolean().optional().describe("true = only models with animations"),
        rigged: z.boolean().optional().describe("true = only rigged models"),
        staffpicked: z.boolean().optional().describe("true = only Sketchfab staff picks"),
        license: z
          .enum(LICENSES)
          .optional()
          .describe("License slug. cc0 = public domain, by = CC Attribution, st = Standard (paid store), ed = Editorial"),
        minFaceCount: z.number().int().min(0).optional().describe("Minimum number of faces"),
        maxFaceCount: z.number().int().min(0).optional().describe("Maximum number of faces (use for low-poly assets)"),
        sortBy: z.enum(SORTS).optional().describe("Sort order. Default is relevance."),
        limit: z.number().int().min(1).max(24).optional().describe("Results per page, 1-24 (default 10)"),
        cursor: z.string().nullish().describe("Pagination cursor from a previous search result"),
        includeThumbnails: z
          .boolean()
          .optional()
          .describe("Also return a small preview image per hit (costs more tokens). Default false."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const { query, tags, categories, cursor } = input;
      if (!query && !tags?.length && !categories?.length && !cursor) {
        return {
          isError: true,
          content: [{ type: "text", text: "Give at least one of: query, tags, categories (or a cursor)." }],
        };
      }

      try {
        const { results, nextCursor } = await client.searchModels({
          q: query,
          tags,
          categories,
          downloadable: input.downloadable,
          animated: input.animated,
          rigged: input.rigged,
          staffpicked: input.staffpicked,
          license: input.license,
          minFaceCount: input.minFaceCount,
          maxFaceCount: input.maxFaceCount,
          sortBy: input.sortBy,
          cursor: cursor ?? undefined,
          count: input.limit ?? 10,
        });

        if (!results.length) {
          return text("No models found. Try fewer filters or different keywords.");
        }

        const summaries = results.map(summarizeModel);
        const lines = summaries.map((s, i) => formatSearchHit(s, i + 1)).join("\n\n");
        const footer = nextCursor ? `\n\nMore results: call again with cursor "${nextCursor}".` : "";
        const content: CallToolResult["content"] = [
          { type: "text", text: `Found ${summaries.length} models:\n\n${lines}${footer}` },
        ];

        if (input.includeThumbnails) {
          const images = await Promise.all(summaries.map((s) => fetchThumbnailBlock(client, s.thumbnailUrl)));
          images.forEach((image, i) => {
            if (image) content.push({ type: "text", text: `[${i + 1}] ${summaries[i].name}` }, image);
          });
        }

        return { content, structuredContent: { results: summaries, ...(nextCursor ? { nextCursor } : {}) } };
      } catch (error) {
        return failure("Search failed", error);
      }
    },
  );

  server.registerTool(
    "sketchfab-model-details",
    {
      title: "Get Sketchfab model details",
      description:
        "Get full information about one Sketchfab model: creator, license and attribution text, geometry size, " +
        "animations, tags, and download size per format. Returns a preview image by default. No API key is needed.",
      inputSchema: {
        modelId: z.string().min(1).describe("Model ID (from search results, or the last part of a sketchfab.com URL)"),
        includeThumbnail: z.boolean().optional().describe("Return a preview image (default true)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ modelId, includeThumbnail = true }) => {
      try {
        const model = await client.getModel(extractModelId(modelId));
        const summary = summarizeModel(model);
        const content: CallToolResult["content"] = [{ type: "text", text: formatModelDetails(model, summary) }];
        if (includeThumbnail) {
          const url = pickThumbnail(model.thumbnails?.images, 512)?.url;
          const image = await fetchThumbnailBlock(client, url);
          if (image) content.push(image);
        }
        return { content, structuredContent: { model: summary } };
      } catch (error) {
        return failure("Could not get model details", error);
      }
    },
  );

  server.registerTool(
    "sketchfab-list-categories",
    {
      title: "List Sketchfab categories",
      description: "List the category slugs that sketchfab-search accepts in `categories`.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const categories = await client.listCategories();
        return {
          content: [{ type: "text", text: categories.map((c) => `${c.slug} — ${c.name}`).join("\n") }],
          structuredContent: { categories: categories.map((c) => ({ slug: c.slug, name: c.name })) },
        };
      } catch (error) {
        return failure("Could not list categories", error);
      }
    },
  );

  server.registerTool(
    "sketchfab-download",
    {
      title: "Download a Sketchfab model",
      description:
        "Download a downloadable Sketchfab model to local disk. ZIP archives (gltf, source) are extracted " +
        "automatically and the main model file is reported. glb is a single self-contained file. " +
        "Needs SKETCHFAB_API_KEY. Respect the license reported in the result.",
      inputSchema: {
        modelId: z.string().min(1).describe("Model ID (must be downloadable)"),
        format: z
          .enum(FORMATS)
          .optional()
          .describe("gltf (ZIP with textures, default), glb (single file), usdz (Apple AR), source (creator's original upload)"),
        outputPath: z
          .string()
          .optional()
          .describe(
            `Directory or file path to save to. A directory gets an auto-generated file name. Default: ${DEFAULT_DOWNLOAD_DIR}`,
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ modelId, format = "gltf", outputPath }) => {
      try {
        const uid = extractModelId(modelId);
        const model = await client.getModel(uid);
        const summary = summarizeModel(model);
        if (!model.isDownloadable) {
          return {
            isError: true,
            content: [{ type: "text", text: `Model "${model.name}" is not downloadable. View it at ${summary.viewerUrl}` }],
          };
        }

        const links = await client.getDownloadLinks(uid);
        const choice = chooseFormat(links, format as DownloadFormat);
        if (!choice) {
          return { isError: true, content: [{ type: "text", text: "Sketchfab offers no download formats for this model." }] };
        }

        const result = await downloadToDisk(
          client,
          links[choice.format]!.url,
          choice.format,
          choice.fellBack,
          outputPath,
          safeFileStem(model.name, uid),
        );

        const lines = [
          `Downloaded "${model.name}" as ${result.format}${result.fellBack ? ` (${format} was not offered)` : ""}.`,
          `Saved to: ${result.savedTo} (${formatBytes(result.bytes)})`,
        ];
        if (result.extractedDir) {
          lines.push(`Extracted ${result.extractedFiles} files to: ${result.extractedDir}`);
          if (result.mainFile) lines.push(`Main model file: ${result.mainFile}`);
        }
        if (result.skippedEntries?.length) {
          lines.push(`Skipped ${result.skippedEntries.length} unsafe archive entries (paths outside the folder).`);
        }
        lines.push(`License: ${summary.license ?? "Unknown"}`, `Attribution: ${attributionLine(summary)}`);

        return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { ...result, model: summary } };
      } catch (error) {
        return failure("Download failed", error);
      }
    },
  );

  return server;
}

/** Accepts a bare UID or a sketchfab.com model URL and returns the UID. */
export function extractModelId(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/([0-9a-f]{32})(?:[/?#]|$)/i);
  return match ? match[1].toLowerCase() : trimmed;
}
