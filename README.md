# Sketchfab MCP Server

A Model Context Protocol (MCP) server for Sketchfab's 3D model platform. It lets Claude, Cursor or any MCP client search, inspect and download 3D models from Sketchfab.

## Features

- **Search** with filters for tags, categories, license, face count, animated, rigged, staff picks and sort order, with pagination.
- **Model details** with creator, license, ready-to-use attribution text, geometry size, download size per format and a preview image.
- **Category list** so the agent uses valid category slugs.
- **Download** in gltf, glb, usdz or source. Files are streamed to disk, ZIP archives are extracted safely, and the main model file is reported.

Search, details and categories work without an API key. Downloads need one.

## Prerequisites

- Node.js 20 or higher
- A Sketchfab API key for downloads (find it at https://sketchfab.com/settings/password)

## Installation

```bash
npm install
npm run build
```

## Configuration

Set the key with the `SKETCHFAB_API_KEY` environment variable. This is preferred over `--api-key`, because command-line arguments are visible to other processes on the machine.

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "sketchfab": {
      "command": "node",
      "args": ["/path/to/sketchfab-mcp-server/build/index.js"],
      "env": { "SKETCHFAB_API_KEY": "YOUR_API_KEY" }
    }
  }
}
```

### Cursor

Settings → MCP → Add new MCP server, type `command`, command `node /path/to/build/index.js`, and add `SKETCHFAB_API_KEY` to the environment.

`--api-key YOUR_API_KEY` and `--api-key=YOUR_API_KEY` still work.

## Tools

### `sketchfab-search`

| Parameter | Type | Notes |
| --- | --- | --- |
| `query` | string | Free text, e.g. `"low poly car"` |
| `tags` | string[] | Tag slugs, e.g. `["rigged", "pbr"]` |
| `categories` | string[] | Category slugs from `sketchfab-list-categories`, e.g. `["cars-vehicles"]` |
| `downloadable`, `animated`, `rigged`, `staffpicked` | boolean | Filters |
| `license` | enum | `cc0`, `by`, `by-sa`, `by-nd`, `by-nc`, `by-nc-sa`, `by-nc-nd`, `free-st`, `st`, `ed` |
| `minFaceCount`, `maxFaceCount` | integer | Geometry budget |
| `sortBy` | enum | `-likeCount`, `-viewCount`, `-publishedAt`, `-processedAt` (default: relevance) |
| `limit` | 1–24 | Default 10 |
| `cursor` | string | From the previous result, for the next page |
| `includeThumbnails` | boolean | Adds a preview image per hit (default false) |

At least one of `query`, `tags`, `categories` or `cursor` is required.

### `sketchfab-model-details`

- `modelId`: a model ID or a full sketchfab.com model URL
- `includeThumbnail` (default true)

### `sketchfab-list-categories`

No parameters.

### `sketchfab-download`

- `modelId`: a model ID or URL (the model must be downloadable)
- `format`: `gltf` (default, ZIP with textures), `glb` (single file), `usdz`, `source`. If the format is not offered, the server falls back to glb → gltf → usdz → source and says so.
- `outputPath`: a directory (existing, ending in `/`, or with no extension) or an exact file path. Missing folders are created. Default: `<os temp>/sketchfab-mcp`.

The result includes the license and an attribution line. Respect the model's license when you use it.

All tools return `structuredContent` alongside text, and errors are flagged with `isError`.

## Development

```bash
npm run dev        # run from source with tsx
npm test           # vitest
npm run lint
npm run typecheck
```

## License

ISC
