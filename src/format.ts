import type { SketchfabModel, SketchfabThumbnail } from "./client.js";

export interface ModelSummary {
  uid: string;
  name: string;
  author: string;
  authorUrl?: string;
  viewerUrl: string;
  license?: string;
  downloadable: boolean;
  faceCount?: number;
  vertexCount?: number;
  animationCount?: number;
  likeCount?: number;
  viewCount?: number;
  staffPicked: boolean;
  publishedAt?: string;
  tags: string[];
  categories: string[];
  thumbnailUrl?: string;
  /** Download size in bytes per format, when Sketchfab reports it. */
  archiveSizes: Record<string, number>;
}

export function summarizeModel(model: SketchfabModel): ModelSummary {
  const archiveSizes: Record<string, number> = {};
  for (const [format, archive] of Object.entries(model.archives ?? {})) {
    if (archive && typeof archive.size === "number") archiveSizes[format] = archive.size;
  }

  return {
    uid: model.uid,
    name: model.name,
    author: model.user?.displayName || model.user?.username || "Unknown",
    authorUrl: model.user?.profileUrl,
    viewerUrl: model.viewerUrl ?? `https://sketchfab.com/3d-models/${model.uid}`,
    license: model.license?.label,
    downloadable: Boolean(model.isDownloadable),
    faceCount: model.faceCount,
    vertexCount: model.vertexCount,
    animationCount: model.animationCount,
    likeCount: model.likeCount,
    viewCount: model.viewCount,
    staffPicked: Boolean(model.staffpickedAt),
    publishedAt: model.publishedAt,
    tags: (model.tags ?? []).map((t) => t.slug),
    categories: (model.categories ?? []).map((c) => c.slug),
    thumbnailUrl: pickThumbnail(model.thumbnails?.images)?.url,
    archiveSizes,
  };
}

/** Picks the smallest thumbnail that is at least `minWidth` wide (or the largest one if none is). */
export function pickThumbnail(
  images: SketchfabThumbnail[] | undefined,
  minWidth = 256,
): SketchfabThumbnail | undefined {
  if (!images?.length) return undefined;
  const sorted = [...images].sort((a, b) => a.width - b.width);
  return sorted.find((img) => img.width >= minWidth) ?? sorted[sorted.length - 1];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatCount(n: number | undefined): string | undefined {
  return n === undefined ? undefined : n.toLocaleString("en-US");
}

export function attributionLine(summary: ModelSummary): string {
  return `"${summary.name}" by ${summary.author} (${summary.viewerUrl})${
    summary.license ? `, licensed under ${summary.license}` : ""
  }`;
}

/** One compact block per search hit. */
export function formatSearchHit(summary: ModelSummary, index: number): string {
  const facts = [
    summary.license && `License: ${summary.license}`,
    summary.faceCount !== undefined && `Faces: ${formatCount(summary.faceCount)}`,
    summary.animationCount ? `Animations: ${summary.animationCount}` : undefined,
    `Downloadable: ${summary.downloadable ? "yes" : "no"}`,
  ].filter(Boolean);

  return [`[${index}] ${summary.name} — by ${summary.author}`, `ID: ${summary.uid}`, facts.join(" | ")].join("\n");
}

export function formatModelDetails(model: SketchfabModel, summary: ModelSummary): string {
  const lines: string[] = [
    `[Model] ${summary.name}`,
    `ID: ${summary.uid}`,
    `Creator: ${summary.author}${summary.authorUrl ? ` (${summary.authorUrl})` : ""}`,
    `Viewer: ${summary.viewerUrl}`,
    `License: ${summary.license ?? "Unknown"}`,
    `Downloadable: ${summary.downloadable ? "yes" : "no"}`,
  ];

  if (summary.faceCount !== undefined) {
    lines.push(`Geometry: ${formatCount(summary.faceCount)} faces, ${formatCount(summary.vertexCount) ?? "?"} vertices`);
  }
  if (summary.animationCount) lines.push(`Animations: ${summary.animationCount}`);
  if (model.isAgeRestricted) lines.push("Age restricted: yes");
  if (summary.staffPicked) lines.push("Staff pick: yes");

  const stats = [
    summary.likeCount !== undefined && `${formatCount(summary.likeCount)} likes`,
    summary.viewCount !== undefined && `${formatCount(summary.viewCount)} views`,
  ].filter(Boolean);
  if (stats.length) lines.push(`Stats: ${stats.join(", ")}`);

  const sizes = Object.entries(summary.archiveSizes);
  if (sizes.length) {
    lines.push(`Download formats: ${sizes.map(([f, s]) => `${f} (${formatBytes(s)})`).join(", ")}`);
  }
  if (summary.categories.length) lines.push(`Categories: ${summary.categories.join(", ")}`);
  if (summary.tags.length) lines.push(`Tags: ${summary.tags.slice(0, 25).join(", ")}`);

  if (model.description) {
    const description = model.description.trim();
    lines.push("", "Description:", description.length > 1500 ? `${description.slice(0, 1500)}…` : description);
  }

  if (summary.license) lines.push("", `Attribution: ${attributionLine(summary)}`);
  return lines.join("\n");
}
