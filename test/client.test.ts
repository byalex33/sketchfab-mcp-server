import { describe, expect, it, vi } from "vitest";
import { buildSearchParams, cursorFromNextUrl, SketchfabApiClient } from "../src/client.js";
import { resolveApiKey } from "../src/config.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("buildSearchParams", () => {
  it("repeats keys for tags and categories (Sketchfab ignores tags[]=)", () => {
    const params = buildSearchParams({ tags: ["rigged", "animated"], categories: ["cars-vehicles"] });
    expect(params.getAll("tags")).toEqual(["rigged", "animated"]);
    expect(params.getAll("categories")).toEqual(["cars-vehicles"]);
    expect(params.toString()).not.toContain("%5B%5D");
  });

  it("maps filters to Sketchfab parameter names and clamps count", () => {
    const params = buildSearchParams({ q: "car", maxFaceCount: 500, sortBy: "-likeCount", license: "cc0", count: 99 });
    expect(params.get("type")).toBe("models");
    expect(params.get("max_face_count")).toBe("500");
    expect(params.get("sort_by")).toBe("-likeCount");
    expect(params.get("license")).toBe("cc0");
    expect(params.get("count")).toBe("24");
  });

  it("keeps false booleans and drops undefined ones", () => {
    const params = buildSearchParams({ q: "x", downloadable: false });
    expect(params.get("downloadable")).toBe("false");
    expect(params.has("animated")).toBe(false);
  });
});

describe("cursorFromNextUrl", () => {
  it("reads the cursor", () => {
    expect(cursorFromNextUrl("https://api.sketchfab.com/v3/search?count=2&cursor=24&q=car")).toBe("24");
  });
  it("handles missing values", () => {
    expect(cursorFromNextUrl(null)).toBeUndefined();
    expect(cursorFromNextUrl("not a url")).toBeUndefined();
  });
});

describe("SketchfabApiClient", () => {
  it("searches without an API key and sends no auth header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ results: [{ uid: "a", name: "A" }], next: "https://api.sketchfab.com/v3/search?cursor=10" }),
    );
    const client = new SketchfabApiClient(undefined, fetchMock);
    const result = await client.searchModels({ q: "car" });

    expect(result.nextCursor).toBe("10");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("sends the token when a key is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    await new SketchfabApiClient("k", fetchMock).searchModels({ q: "car" });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Token k");
  });

  it("refuses download links without a key, before any request", async () => {
    const fetchMock = vi.fn();
    await expect(new SketchfabApiClient(undefined, fetchMock).getDownloadLinks("abc")).rejects.toThrow(
      /SKETCHFAB_API_KEY/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, {}, /rejected the API key/],
    [404, {}, /No Sketchfab model with ID "abc"/],
    [429, { "retry-after": "30" }, /Retry after 30 seconds/],
    [500, {}, /Sketchfab API error \(500\)/],
  ])("maps HTTP %i to a clear error", async (status, headers, pattern) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: "x" }, status, headers));
    await expect(new SketchfabApiClient("k", fetchMock).getModel("abc")).rejects.toThrow(pattern);
  });
});

describe("resolveApiKey", () => {
  it("reads --api-key in both forms, then the environment", () => {
    expect(resolveApiKey(["--api-key", "a"], {})).toBe("a");
    expect(resolveApiKey(["--api-key=b"], {})).toBe("b");
    expect(resolveApiKey([], { SKETCHFAB_API_KEY: "c" })).toBe("c");
    expect(resolveApiKey([], {})).toBeUndefined();
  });
});
