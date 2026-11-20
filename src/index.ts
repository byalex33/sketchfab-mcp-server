#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SketchfabApiClient } from "./client.js";
import { resolveApiKey } from "./config.js";
import { createServer } from "./server.js";

async function main() {
  const apiKey = resolveApiKey(process.argv.slice(2), process.env);
  const server = createServer(new SketchfabApiClient(apiKey));

  // stdout carries the MCP protocol: all logging must go to stderr.
  console.error(
    apiKey
      ? "Sketchfab MCP: API key found."
      : "Sketchfab MCP: no API key. Search and details work; downloads need SKETCHFAB_API_KEY.",
  );

  await server.connect(new StdioServerTransport());
  console.error("Sketchfab MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
