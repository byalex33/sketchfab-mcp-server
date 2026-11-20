import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import AdmZip from "adm-zip";
import type { DownloadFormat, DownloadLinks, SketchfabApiClient } from "./client.js";

export const DEFAULT_DOWNLOAD_DIR = path.join(os.tmpdir(), "sketchfab-mcp");

/** Order used when the requested format is not offered. */
export const FORMAT_PREFERENCE: DownloadFormat[] = ["glb", "gltf", "usdz", "source"];

export function chooseFormat(
  links: DownloadLinks,
  requested: DownloadFormat,
): { format: DownloadFormat; fellBack: boolean } | undefined {
  if (links[requested]?.url) return { format: requested, fellBack: false };
  const fallback = FORMAT_PREFERENCE.find((f) => links[f]?.url);
  return fallback ? { format: fallback, fellBack: true } : undefined;
}

export function safeFileStem(name: string, uid: string): string {
  const stem = name
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return `${stem || "model"}_${uid}`;
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith(`~${path.sep}`) || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Works out where to save a download.
 * - no outputPath → DEFAULT_DOWNLOAD_DIR/<stem>
 * - an existing directory, a path ending in a separator, or a path without an extension → that directory/<stem>
 * - anything else → that exact file path
 * `filePath` is returned without an extension when the caller should pick one (`exact: false`).
 */
export function resolveOutputTarget(
  outputPath: string | undefined,
  stem: string,
): { dir: string; filePath: string; exact: boolean } {
  if (!outputPath) {
    return { dir: DEFAULT_DOWNLOAD_DIR, filePath: path.join(DEFAULT_DOWNLOAD_DIR, stem), exact: false };
  }

  const expanded = path.resolve(expandHome(outputPath));
  const looksLikeDir =
    /[\\/]$/.test(outputPath) ||
    (fs.existsSync(expanded) && fs.statSync(expanded).isDirectory()) ||
    path.extname(expanded) === "";

  if (looksLikeDir) return { dir: expanded, filePath: path.join(expanded, stem), exact: false };
  return { dir: path.dirname(expanded), filePath: expanded, exact: true };
}

export function isZipFile(filePath: string): boolean {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(4);
    const read = fs.readSync(fd, header, 0, 4, 0);
    return (
      read === 4 &&
      header[0] === 0x50 &&
      header[1] === 0x4b &&
      [0x03, 0x05, 0x07].includes(header[2]) &&
      [0x04, 0x06, 0x08].includes(header[3])
    );
  } finally {
    fs.closeSync(fd);
  }
}

/** Extracts a ZIP, refusing any entry that would land outside `outputDir` (zip-slip). */
export function extractZipSafely(zipPath: string, outputDir: string): { files: string[]; skipped: string[] } {
  const root = path.resolve(outputDir);
  fs.mkdirSync(root, { recursive: true });

  const files: string[] = [];
  const skipped: string[] = [];
  for (const entry of new AdmZip(zipPath).getEntries()) {
    const target = path.resolve(root, entry.entryName);
    if (target !== root && !target.startsWith(root + path.sep)) {
      skipped.push(entry.entryName);
      continue;
    }
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
    files.push(target);
  }
  return { files, skipped };
}

const MAIN_FILE_EXTENSIONS = [".glb", ".gltf", ".usdz", ".fbx", ".obj", ".blend", ".dae", ".stl", ".3ds", ".max"];

/** Picks the file an agent most likely wants to open from an extracted archive. */
export function findMainFile(files: string[]): string | undefined {
  for (const ext of MAIN_FILE_EXTENSIONS) {
    const matches = files.filter((f) => path.extname(f).toLowerCase() === ext);
    if (matches.length) return matches.sort((a, b) => a.length - b.length)[0];
  }
  return undefined;
}

export interface DownloadResult {
  format: DownloadFormat;
  fellBack: boolean;
  savedTo: string;
  bytes: number;
  extractedDir?: string;
  extractedFiles?: number;
  mainFile?: string;
  skippedEntries?: string[];
}

/** Streams the archive to disk (never fully in memory), then extracts it if it is a ZIP. */
export async function downloadToDisk(
  client: SketchfabApiClient,
  url: string,
  format: DownloadFormat,
  fellBack: boolean,
  outputPath: string | undefined,
  stem: string,
): Promise<DownloadResult> {
  const target = resolveOutputTarget(outputPath, stem);
  fs.mkdirSync(target.dir, { recursive: true });

  const partPath = `${target.filePath}.part`;
  const response = await client.fetchBinary(url);
  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
      fs.createWriteStream(partPath),
    );
  } catch (error) {
    fs.rmSync(partPath, { force: true });
    throw error;
  }

  const zip = isZipFile(partPath);
  const finalPath = target.exact ? target.filePath : `${target.filePath}.${zip ? "zip" : format}`;
  fs.renameSync(partPath, finalPath);
  const result: DownloadResult = { format, fellBack, savedTo: finalPath, bytes: fs.statSync(finalPath).size };

  if (zip) {
    const extractedDir = path.join(target.dir, `${path.basename(finalPath, path.extname(finalPath))}`);
    const dir = extractedDir === finalPath ? `${extractedDir}_extracted` : extractedDir;
    const { files, skipped } = extractZipSafely(finalPath, dir);
    result.extractedDir = dir;
    result.extractedFiles = files.length;
    result.mainFile = findMainFile(files);
    if (skipped.length) result.skippedEntries = skipped;
  }
  return result;
}
