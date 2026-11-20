export const API_BASE = "https://api.sketchfab.com/v3";

export interface SketchfabThumbnail {
  url: string;
  width: number;
  height: number;
}

export interface SketchfabArchive {
  type?: string;
  size?: number | null;
  faceCount?: number | null;
  vertexCount?: number | null;
  textureCount?: number | null;
  textureMaxResolution?: number | null;
}

export interface SketchfabModel {
  uid: string;
  name: string;
  description?: string;
  viewerUrl?: string;
  embedUrl?: string;
  thumbnails?: { images?: SketchfabThumbnail[] };
  user?: { username: string; displayName?: string; profileUrl?: string };
  isDownloadable: boolean;
  isAgeRestricted?: boolean;
  downloadCount?: number;
  viewCount?: number;
  likeCount?: number;
  animationCount?: number;
  license?: { uid?: string; slug?: string; label?: string } | null;
  createdAt?: string;
  publishedAt?: string;
  staffpickedAt?: string | null;
  faceCount?: number;
  vertexCount?: number;
  tags?: Array<{ slug: string; name?: string }>;
  categories?: Array<{ name: string; slug: string }>;
  archives?: Record<string, SketchfabArchive | null>;
}

export interface SketchfabCategory {
  uid?: string;
  name: string;
  slug: string;
}

export type DownloadFormat = "gltf" | "glb" | "usdz" | "source";

export type DownloadLinks = Partial<
  Record<DownloadFormat, { url: string; size?: number; expires?: number }>
>;

export interface SearchOptions {
  q?: string;
  tags?: string[];
  categories?: string[];
  downloadable?: boolean;
  animated?: boolean;
  rigged?: boolean;
  staffpicked?: boolean;
  license?: string;
  minFaceCount?: number;
  maxFaceCount?: number;
  sortBy?: string;
  cursor?: string;
  count?: number;
}

export interface SearchResult {
  results: SketchfabModel[];
  nextCursor?: string;
}

export class SketchfabApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SketchfabApiError";
  }
}

/** Reads the `cursor` query parameter from a Sketchfab `next` URL. */
export function cursorFromNextUrl(next: string | null | undefined): string | undefined {
  if (!next) return undefined;
  try {
    return new URL(next).searchParams.get("cursor") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the query string for /v3/search. Sketchfab expects repeated keys
 * (`tags=a&tags=b`); the bracket form (`tags[]=a`) is silently ignored.
 */
export function buildSearchParams(options: SearchOptions): URLSearchParams {
  const params = new URLSearchParams({ type: "models" });
  const set = (key: string, value: string | number | boolean | undefined) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  };

  set("q", options.q);
  for (const tag of options.tags ?? []) params.append("tags", tag);
  for (const category of options.categories ?? []) params.append("categories", category);
  set("downloadable", options.downloadable);
  set("animated", options.animated);
  set("rigged", options.rigged);
  set("staffpicked", options.staffpicked);
  set("license", options.license);
  set("min_face_count", options.minFaceCount);
  set("max_face_count", options.maxFaceCount);
  set("sort_by", options.sortBy);
  set("cursor", options.cursor);
  set("count", Math.min(Math.max(options.count ?? 10, 1), 24));
  return params;
}

export class SketchfabApiClient {
  constructor(
    private readonly apiKey?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  private async request<T>(
    path: string,
    { params, requireAuth = false, notFound }: {
      params?: URLSearchParams;
      requireAuth?: boolean;
      notFound?: string;
    } = {},
  ): Promise<T> {
    if (requireAuth && !this.apiKey) {
      throw new SketchfabApiError(
        "This action needs a Sketchfab API key. Set the SKETCHFAB_API_KEY environment variable " +
          "(get a key at https://sketchfab.com/settings/password).",
      );
    }

    const url = `${API_BASE}${path}${params ? `?${params}` : ""}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers.Authorization = `Token ${this.apiKey}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      throw new SketchfabApiError(`Could not reach Sketchfab: ${errorMessage(error)}`);
    }

    if (response.ok) return (await response.json()) as T;

    const status = response.status;
    const detail = await readErrorDetail(response);
    switch (status) {
      case 401:
        throw new SketchfabApiError("Sketchfab rejected the API key (401). Check SKETCHFAB_API_KEY.", status);
      case 403:
        throw new SketchfabApiError(
          `Sketchfab denied access (403)${detail ? `: ${detail}` : ""}. The model may not be downloadable with this account.`,
          status,
        );
      case 404:
        throw new SketchfabApiError(notFound ?? `Not found (404): ${path}`, status);
      case 429: {
        const retryAfter = response.headers.get("retry-after");
        throw new SketchfabApiError(
          `Sketchfab rate limit reached (429).${retryAfter ? ` Retry after ${retryAfter} seconds.` : " Try again later."}`,
          status,
        );
      }
      default:
        throw new SketchfabApiError(`Sketchfab API error (${status})${detail ? `: ${detail}` : ""}`, status);
    }
  }

  async searchModels(options: SearchOptions): Promise<SearchResult> {
    const data = await this.request<{ results?: SketchfabModel[]; next?: string | null }>("/search", {
      params: buildSearchParams(options),
    });
    return { results: data.results ?? [], nextCursor: cursorFromNextUrl(data.next) };
  }

  async getModel(uid: string): Promise<SketchfabModel> {
    return this.request<SketchfabModel>(`/models/${encodeURIComponent(uid)}`, {
      notFound: `No Sketchfab model with ID "${uid}".`,
    });
  }

  async getDownloadLinks(uid: string): Promise<DownloadLinks> {
    return this.request<DownloadLinks>(`/models/${encodeURIComponent(uid)}/download`, {
      requireAuth: true,
      notFound: `No Sketchfab model with ID "${uid}", or it is not downloadable.`,
    });
  }

  async listCategories(): Promise<SketchfabCategory[]> {
    const data = await this.request<{ results?: SketchfabCategory[] }>("/categories");
    return data.results ?? [];
  }

  /** Fetches a binary resource (download URL or thumbnail). No auth header: these are pre-signed CDN URLs. */
  async fetchBinary(url: string, timeoutMs = 600_000): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new SketchfabApiError(`Download failed: ${errorMessage(error)}`);
    }
    if (!response.ok || !response.body) {
      throw new SketchfabApiError(`Download failed (${response.status})`, response.status);
    }
    return response;
  }
}

async function readErrorDetail(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    return typeof body.detail === "string" ? body.detail : undefined;
  } catch {
    return undefined;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
