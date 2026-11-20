import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SketchfabApiClient } from "../src/client.js";
import {
  chooseFormat,
  DEFAULT_DOWNLOAD_DIR,
  downloadToDisk,
  extractZipSafely,
  findMainFile,
  resolveOutputTarget,
  safeFileStem,
} from "../src/download.js";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sketchfab-mcp-test-"));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeClient(body: Buffer): SketchfabApiClient {
  return { fetchBinary: async () => new Response(new Uint8Array(body)) } as unknown as SketchfabApiClient;
}

describe("resolveOutputTarget", () => {
  it("uses the default folder when no path is given", () => {
    const t = resolveOutputTarget(undefined, "stem");
    expect(t).toEqual({ dir: DEFAULT_DOWNLOAD_DIR, filePath: path.join(DEFAULT_DOWNLOAD_DIR, "stem"), exact: false });
  });

  it("treats an existing directory as a directory", () => {
    const t = resolveOutputTarget(tmp, "stem");
    expect(t.dir).toBe(tmp);
    expect(t.exact).toBe(false);
  });

  it("treats a new path without an extension, or with a trailing slash, as a directory", () => {
    expect(resolveOutputTarget(path.join(tmp, "new-folder"), "s").exact).toBe(false);
    expect(resolveOutputTarget(path.join(tmp, "x.y") + "/", "s").exact).toBe(false);
  });

  it("treats a path with an extension as an exact file", () => {
    const t = resolveOutputTarget(path.join(tmp, "car.glb"), "s");
    expect(t).toEqual({ dir: tmp, filePath: path.join(tmp, "car.glb"), exact: true });
  });
});

describe("chooseFormat", () => {
  it("uses the requested format when offered", () => {
    expect(chooseFormat({ gltf: { url: "u" } }, "gltf")).toEqual({ format: "gltf", fellBack: false });
  });
  it("falls back in preference order", () => {
    expect(chooseFormat({ source: { url: "s" }, glb: { url: "g" } }, "usdz")).toEqual({ format: "glb", fellBack: true });
  });
  it("returns undefined when nothing is offered", () => {
    expect(chooseFormat({}, "gltf")).toBeUndefined();
  });
});

describe("safeFileStem", () => {
  it("makes a filesystem-safe name", () => {
    expect(safeFileStem("Café / Chair: v2!", "abc")).toBe("Cafe_Chair_v2_abc");
    expect(safeFileStem("???", "abc")).toBe("model_abc");
  });
});

describe("extractZipSafely", () => {
  it("skips entries that escape the output folder", () => {
    const zip = new AdmZip();
    zip.addFile("scene.gltf", Buffer.from("{}"));
    zip.addFile("textures/a.png", Buffer.from("png"));
    const zipPath = path.join(tmp, "evil.zip");
    zip.writeZip(zipPath);

    // adm-zip normalises names on addFile, so patch (same length) a traversal name into the central directory by hand.
    const raw = fs.readFileSync(zipPath);
    const patched = Buffer.from(raw.toString("latin1").replaceAll("textures/a.png", "../../evil.png"), "latin1");
    fs.writeFileSync(zipPath, patched);

    const outDir = path.join(tmp, "evil");
    const { files, skipped } = extractZipSafely(zipPath, outDir);
    expect(files).toEqual([path.join(outDir, "scene.gltf")]);
    expect(skipped).toEqual(["../../evil.png"]);
    expect(fs.existsSync(path.join(tmp, "..", "evil.png"))).toBe(false);
  });
});

describe("findMainFile", () => {
  it("prefers model files over textures", () => {
    expect(findMainFile(["/a/textures/x.png", "/a/scene.gltf", "/a/scene.bin"])).toBe("/a/scene.gltf");
    expect(findMainFile(["/a/readme.txt"])).toBeUndefined();
  });
});

describe("downloadToDisk", () => {
  it("saves a ZIP with a .zip name and extracts it", async () => {
    const zip = new AdmZip();
    zip.addFile("scene.gltf", Buffer.from("{}"));
    zip.addFile("scene.bin", Buffer.from("bin"));
    const out = path.join(tmp, "dl-zip");

    const result = await downloadToDisk(fakeClient(zip.toBuffer()), "https://x", "gltf", false, out, "chair_abc");
    expect(result.savedTo).toBe(path.join(out, "chair_abc.zip"));
    expect(result.extractedDir).toBe(path.join(out, "chair_abc"));
    expect(result.extractedFiles).toBe(2);
    expect(result.mainFile).toBe(path.join(out, "chair_abc", "scene.gltf"));
    expect(fs.existsSync(`${path.join(out, "chair_abc")}.part`)).toBe(false);
  });

  it("saves a non-ZIP with the format extension", async () => {
    const out = path.join(tmp, "dl-glb");
    const result = await downloadToDisk(fakeClient(Buffer.from("glTF....")), "https://x", "glb", false, out, "car_x");
    expect(result.savedTo).toBe(path.join(out, "car_x.glb"));
    expect(result.extractedDir).toBeUndefined();
    expect(fs.readFileSync(result.savedTo, "utf8")).toBe("glTF....");
  });

  it("writes to an exact file path and creates missing parent folders", async () => {
    const file = path.join(tmp, "deep", "er", "my.glb");
    const result = await downloadToDisk(fakeClient(Buffer.from("glTF")), "https://x", "glb", false, file, "ignored");
    expect(result.savedTo).toBe(file);
    expect(fs.existsSync(file)).toBe(true);
  });
});
