import { spawn } from "node:child_process";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { SketchfabApiClient } from "../src/client.js";
import { formatBytes, pickThumbnail, summarizeModel } from "../src/format.js";
import { createServer, extractModelId } from "../src/server.js";

const MODEL = {
  uid: "9aea3b516d3e4e169710049b32282670",
  name: "Chair",
  isDownloadable: true,
  faceCount: 1200,
  vertexCount: 800,
  animationCount: 0,
  viewerUrl: "https://sketchfab.com/3d-models/chair-9aea3b516d3e4e169710049b32282670",
  user: { username: "maker", displayName: "Maker" },
  license: { uid: "l", label: "CC Attribution" },
  tags: [{ slug: "chair" }],
  categories: [{ name: "Furniture & Home", slug: "furniture-home" }],
  archives: { glb: { size: 2048 }, gltf: { size: 4096 }, source: null },
  thumbnails: { images: [] },
};

async function connect(fetchImpl: typeof fetch, apiKey?: string) {
  const server = createServer(new SketchfabApiClient(apiKey, fetchImpl));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("MCP server", () => {
  it("lists the four real tools and no sample tool", async () => {
    const client = await connect(vi.fn());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "sketchfab-download",
      "sketchfab-list-categories",
      "sketchfab-model-details",
      "sketchfab-search",
    ]);
    expect(tools.find((t) => t.name === "sketchfab-search")?.annotations?.readOnlyHint).toBe(true);
  });

  it("searches without a key and reports license, faces and the next cursor", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({ results: [MODEL], next: "https://api.sketchfab.com/v3/search?cursor=10" }),
    );
    const client = await connect(fetchMock);
    const result = await client.callTool({ name: "sketchfab-search", arguments: { query: "chair" } });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("License: CC Attribution");
    expect(text).toContain("Faces: 1,200");
    expect(text).toContain('cursor "10"');
    expect((result.structuredContent as { nextCursor: string }).nextCursor).toBe("10");
  });

  it("marks API failures with isError", async () => {
    const client = await connect(vi.fn().mockResolvedValue(json({}, 500)));
    const result = await client.callTool({ name: "sketchfab-model-details", arguments: { modelId: "x" } });
    expect(result.isError).toBe(true);
  });

  it("rejects a search with no criteria", async () => {
    const client = await connect(vi.fn());
    const result = await client.callTool({ name: "sketchfab-search", arguments: {} });
    expect(result.isError).toBe(true);
  });

  it("asks for a key on download when none is set", async () => {
    const client = await connect(vi.fn().mockResolvedValue(json(MODEL)));
    const result = await client.callTool({ name: "sketchfab-download", arguments: { modelId: MODEL.uid } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain("SKETCHFAB_API_KEY");
  });
});

describe("helpers", () => {
  it("extracts a model ID from a URL", () => {
    expect(extractModelId(MODEL.viewerUrl)).toBe(MODEL.uid);
    expect(extractModelId(" abc ")).toBe("abc");
  });

  it("summarises archives and license", () => {
    const s = summarizeModel(MODEL as never);
    expect(s.license).toBe("CC Attribution");
    expect(s.archiveSizes).toEqual({ glb: 2048, gltf: 4096 });
    expect(s.author).toBe("Maker");
  });

  it("picks a thumbnail and formats bytes", () => {
    const images = [100, 300, 1024].map((w) => ({ url: `u${w}`, width: w, height: w }));
    expect(pickThumbnail(images)?.url).toBe("u300");
    expect(pickThumbnail(images, 5000)?.url).toBe("u1024");
    expect(formatBytes(34_741_352)).toBe("33 MB");
  });
});

describe("built server over stdio", () => {
  it("writes only JSON-RPC to stdout", async () => {
    const child = spawn(process.execPath, [path.resolve("build/index.js")], {
      env: { ...process.env, SKETCHFAB_API_KEY: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }) + "\n",
    );
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.stdout.on("data", () => stdout.includes("\n") && done());
      setTimeout(done, 5000);
    });
    child.kill();

    const lines = stdout.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(JSON.parse(lines[0]).result.serverInfo.name).toBe("sketchfab-mcp-server");
  });
});
