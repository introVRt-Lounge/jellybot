import { parseTvMediaQuery } from "./tv-query.ts";
import type { SubtitleStreamCandidate } from "./subtitles/track-select.ts";
import { displayTitle, displayTitleWithYear } from "./display-title.ts";

export type MediaKind = "movie" | "tv";

export type JellyfinItem = {
  id: string;
  name: string;
  originalTitle?: string;
  type: string;
  seriesName?: string;
  seasonName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  productionYear?: number;
  runtimeTicks?: number;
  path?: string;
};

export type JellyfinMediaStream = SubtitleStreamCandidate;

export type JellyfinMediaSource = {
  id: string;
  streams: JellyfinMediaStream[];
};

export type JellyfinItemWithMedia = JellyfinItem & {
  dateLastRefreshed?: string;
  mediaSource: JellyfinMediaSource;
};

export type SubtitledMediaListItem = JellyfinItem & {
  dateLastRefreshed?: string;
};

export type SubtitledMediaPage = {
  total: number;
  items: SubtitledMediaListItem[];
};

type JellyfinMediaSourceResponse = {
  Id: string;
  MediaStreams?: Array<{
    Type: string;
    Index: number;
    Codec?: string;
    Language?: string;
    IsDefault?: boolean;
    IsForced?: boolean;
    IsTextSubtitleStream?: boolean;
  }>;
};

type JellyfinSearchResponse = {
  TotalRecordCount?: number;
  Items?: Array<{
    Id: string;
    Name: string;
    OriginalTitle?: string;
    Type: string;
    SeriesName?: string;
    SeasonName?: string;
    ParentIndexNumber?: number;
    IndexNumber?: number;
    ProductionYear?: number;
    RunTimeTicks?: number;
    Path?: string;
    DateLastRefreshed?: string;
    ProviderIds?: Record<string, string | undefined>;
    MediaSources?: Array<JellyfinMediaSourceResponse & { Path?: string }>;
  }>;
};

type JellyfinItemResponse = NonNullable<JellyfinSearchResponse["Items"]>[number];

type AuthResponse = {
  AccessToken: string;
  User: {
    Id: string;
    Name: string;
  };
};

const CLIENT_INFO = {
  client: "jellybot",
  device: "jellybot",
  deviceId: "jellybot",
  version: "1.0.0",
};

const JELLYFIN_ITEM_ID_PATTERN = /^[a-f0-9]{32}$/i;
const ITEM_FIELDS =
  "Path,ParentId,SeriesName,SeasonName,ParentIndexNumber,IndexNumber,ProductionYear,RunTimeTicks,OriginalTitle";
const MEDIA_ITEM_FIELDS =
  "Path,ParentId,SeriesName,SeasonName,ParentIndexNumber,IndexNumber,ProductionYear,RunTimeTicks,DateLastRefreshed,MediaSources,OriginalTitle";
const TV_SERIES_EXPAND_LIMIT = 3;
const TV_EPISODES_PER_SERIES = 25;

// Paged-fallback caps for the provider-id lookups (issue #126). The first
// hop is a server-side `searchTerm=<title>` query and almost always lands the
// item in one round-trip; these only kick in when the webhook payload didn't
// carry a usable title. The cap on pages keeps us from walking a 5k-movie
// library when the requested id genuinely isn't there.
const MOVIE_PROVIDER_LOOKUP_PAGE_SIZE = 200;
const MOVIE_PROVIDER_LOOKUP_MAX_PAGES = 30;
const SERIES_PROVIDER_LOOKUP_PAGE_SIZE = 200;
const SERIES_PROVIDER_LOOKUP_MAX_PAGES = 5;

export type EpisodeListOptions = {
  limit: number;
  query?: string;
  signal?: AbortSignal;
};

export type JellyfinRequestOptions = {
  signal?: AbortSignal;
};

export function isJellyfinItemId(value: string): boolean {
  return JELLYFIN_ITEM_ID_PATTERN.test(value.trim());
}

export type TvSearchExpandOptions = {
  maxSeriesToExpand: number;
  episodesPerSeries: number;
  totalLimit: number;
  signal?: AbortSignal;
};

export async function resolveTvSearchResults(
  episodes: JellyfinItem[],
  series: JellyfinItem[],
  query: string,
  listEpisodesForSeries: (seriesId: string, options: EpisodeListOptions) => Promise<JellyfinItem[]>,
  options: TvSearchExpandOptions,
): Promise<JellyfinItem[]> {
  if (episodes.length > 0) {
    return episodes.slice(0, options.totalLimit);
  }

  const expanded: JellyfinItem[] = [];
  const seen = new Set<string>();

  for (const show of series.slice(0, options.maxSeriesToExpand)) {
    throwIfAborted(options.signal);
    const remaining = options.totalLimit - expanded.length;
    if (remaining <= 0) break;

    const showEpisodes = await listEpisodesForSeries(show.id, {
      limit: Math.min(options.episodesPerSeries, remaining),
      query,
      signal: options.signal,
    });

    for (const episode of showEpisodes) {
      if (seen.has(episode.id)) continue;
      seen.add(episode.id);
      expanded.push({
        ...episode,
        seriesName: episode.seriesName ?? show.name,
      });
      if (expanded.length >= options.totalLimit) {
        return expanded;
      }
    }
  }

  return expanded;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

export class JellyfinClient {
  private accessToken?: string;
  private userId?: string;
  private username?: string;

  constructor(
    private readonly baseUrl: string,
    private readonly usernameInput: string,
    private readonly password: string,
    private readonly moviesLibraryId: string,
    private readonly tvLibraryId: string,
  ) {}

  get userName(): string | undefined {
    return this.username;
  }

  async authenticate(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/Users/AuthenticateByName`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Emby-Authorization": `MediaBrowser Client="${CLIENT_INFO.client}", Device="${CLIENT_INFO.device}", DeviceId="${CLIENT_INFO.deviceId}", Version="${CLIENT_INFO.version}"`,
      },
      body: JSON.stringify({
        Username: this.usernameInput,
        Pw: this.password,
      }),
    });

    if (!response.ok) {
      throw new Error(`Jellyfin authentication failed (${response.status}).`);
    }

    const data = (await response.json()) as AuthResponse;
    this.accessToken = data.AccessToken;
    this.userId = data.User.Id;
    this.username = data.User.Name;
  }

  private requireAuth(): { accessToken: string; userId: string } {
    if (!this.accessToken || !this.userId) {
      throw new Error("Jellyfin client is not authenticated.");
    }

    return { accessToken: this.accessToken, userId: this.userId };
  }

  private headers(extra: HeadersInit = {}): HeadersInit {
    const { accessToken } = this.requireAuth();
    return {
      "X-Emby-Token": accessToken,
      Accept: "application/json",
      ...extra,
    };
  }

  private async fetchAuthed(url: string, init: RequestInit = {}): Promise<Response> {
    let response = await fetch(url, {
      ...init,
      headers: this.headers(init.headers ?? {}),
    });

    if (response.status === 401) {
      await this.authenticate();
      response = await fetch(url, {
        ...init,
        headers: this.headers(init.headers ?? {}),
      });
    }

    return response;
  }

  async search(
    query: string,
    kind: MediaKind,
    limit = 25,
    options: JellyfinRequestOptions = {},
  ): Promise<JellyfinItem[]> {
    throwIfAborted(options.signal);
    if (kind === "movie") {
      return this.searchItems({
        query,
        includeItemTypes: "Movie",
        parentId: this.moviesLibraryId,
        limit,
        signal: options.signal,
      });
    }

    return this.searchTv(query, limit, options.signal);
  }

  private async searchTv(query: string, limit: number, signal?: AbortSignal): Promise<JellyfinItem[]> {
    throwIfAborted(signal);
    const parentId = this.tvLibraryId;
    const parsed = parseTvMediaQuery(query);
    const seriesQuery = parsed.seriesText.length >= 2 ? parsed.seriesText : query;

    const [episodes, series] = await Promise.all([
      this.searchItems({
        query,
        includeItemTypes: "Episode",
        parentId,
        limit,
        signal,
      }),
      this.searchItems({
        query: seriesQuery,
        includeItemTypes: "Series",
        parentId,
        limit: TV_SERIES_EXPAND_LIMIT,
        signal,
      }),
    ]);

    return resolveTvSearchResults(
      episodes,
      series,
      query,
      (seriesId, episodeOptions) => this.listEpisodesForSeries(seriesId, episodeOptions),
      {
        maxSeriesToExpand: TV_SERIES_EXPAND_LIMIT,
        episodesPerSeries: TV_EPISODES_PER_SERIES,
        totalLimit: limit,
        signal,
      },
    );
  }

  private async searchItems(params: {
    query: string;
    includeItemTypes: string;
    parentId: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<JellyfinItem[]> {
    throwIfAborted(params.signal);
    const { userId } = this.requireAuth();
    const searchParams = new URLSearchParams({
      UserId: userId,
      SearchTerm: params.query,
      IncludeItemTypes: params.includeItemTypes,
      ParentId: params.parentId,
      Recursive: "true",
      Limit: String(params.limit),
      Fields: ITEM_FIELDS,
    });

    const response = await this.fetchAuthed(`${this.baseUrl}/Items?${searchParams}`, {
      signal: params.signal,
    });

    if (!response.ok) {
      throw new Error(`Jellyfin search failed (${response.status}).`);
    }

    const data = (await response.json()) as JellyfinSearchResponse;
    return this.mapItems(data);
  }

  private async listEpisodesForSeries(seriesId: string, options: EpisodeListOptions): Promise<JellyfinItem[]> {
    throwIfAborted(options.signal);
    const parsed = parseTvMediaQuery(options.query ?? "");
    const { userId } = this.requireAuth();
    const searchParams = new URLSearchParams({
      UserId: userId,
      ParentId: seriesId,
      IncludeItemTypes: "Episode",
      Recursive: "true",
      SortBy: "ParentIndexNumber,IndexNumber",
      SortOrder: "Ascending",
      Limit: String(options.limit),
      Fields: ITEM_FIELDS,
    });

    if (parsed.seasonNumber != null) {
      searchParams.set("ParentIndexNumber", String(parsed.seasonNumber));
    }

    if (parsed.episodeNumber != null) {
      searchParams.set("IndexNumber", String(parsed.episodeNumber));
    }

    const hasIndexHint = parsed.seasonNumber != null || parsed.episodeNumber != null;
    const searchTerm = parsed.seriesText.trim();
    if (!hasIndexHint && searchTerm.length >= 2) {
      searchParams.set("SearchTerm", searchTerm);
    }

    let items = await this.fetchEpisodeItems(searchParams, options.signal);
    if (items.length === 0 && searchTerm.length >= 2 && !hasIndexHint) {
      searchParams.delete("SearchTerm");
      items = await this.fetchEpisodeItems(searchParams, options.signal);
    }

    return items;
  }

  private async fetchEpisodeItems(searchParams: URLSearchParams, signal?: AbortSignal): Promise<JellyfinItem[]> {
    throwIfAborted(signal);
    const response = await this.fetchAuthed(`${this.baseUrl}/Items?${searchParams}`, { signal });

    if (!response.ok) {
      throw new Error(`Jellyfin episode lookup failed (${response.status}).`);
    }

    const data = (await response.json()) as JellyfinSearchResponse;
    return this.mapItems(data);
  }

  async getItem(itemId: string): Promise<JellyfinItem | null> {
    const item = await this.fetchUserItem(itemId, ITEM_FIELDS);
    return item ? this.mapItem(item) : null;
  }

  async getItemWithMedia(itemId: string): Promise<JellyfinItemWithMedia | null> {
    const item = await this.fetchUserItem(itemId, MEDIA_ITEM_FIELDS);
    if (!item) return null;

    const mediaSource = this.pickPrimaryMediaSource(item.MediaSources);
    if (!mediaSource) return null;

    return {
      ...this.mapItem(item),
      dateLastRefreshed: item.DateLastRefreshed,
      mediaSource,
    };
  }

  async countMediaItems(filter: {
    includeItemTypes: "Movie" | "Episode" | "Series" | "Movie,Episode";
    hasSubtitles?: boolean;
    parentId?: string;
    ids?: string;
  }): Promise<number> {
    const { userId } = this.requireAuth();
    const searchParams = new URLSearchParams({
      UserId: userId,
      IncludeItemTypes: filter.includeItemTypes,
      Recursive: "true",
      Limit: "1",
    });

    if (filter.hasSubtitles) {
      searchParams.set("HasSubtitles", "true");
    }
    if (filter.parentId) {
      searchParams.set("ParentId", filter.parentId);
    }
    if (filter.ids) {
      searchParams.set("Ids", filter.ids);
    }

    const response = await this.fetchAuthed(`${this.baseUrl}/Items?${searchParams}`);

    if (!response.ok) {
      throw new Error(`Jellyfin item count failed (${response.status}).`);
    }

    const data = (await response.json()) as JellyfinSearchResponse;
    return data.TotalRecordCount ?? 0;
  }

  async countSubtitledMedia(): Promise<number> {
    return this.countMediaItems({ includeItemTypes: "Movie,Episode", hasSubtitles: true });
  }

  async countLibraryMovies(options: { hasSubtitles?: boolean } = {}): Promise<number> {
    return this.countMediaItems({
      includeItemTypes: "Movie",
      parentId: this.moviesLibraryId,
      hasSubtitles: options.hasSubtitles,
    });
  }

  async countLibraryEpisodes(options: { hasSubtitles?: boolean } = {}): Promise<number> {
    return this.countMediaItems({
      includeItemTypes: "Episode",
      parentId: this.tvLibraryId,
      hasSubtitles: options.hasSubtitles,
    });
  }

  async countSeriesEpisodes(
    seriesId: string,
    options: { hasSubtitles?: boolean } = {},
  ): Promise<number> {
    return this.countMediaItems({
      includeItemTypes: "Episode",
      parentId: seriesId,
      hasSubtitles: options.hasSubtitles,
    });
  }

  async movieHasSubtitles(movieId: string): Promise<boolean> {
    const count = await this.countMediaItems({
      includeItemTypes: "Movie",
      ids: movieId,
      hasSubtitles: true,
    });
    return count > 0;
  }

  /**
   * Look up a Jellyfin movie item by TMDB id (used after Radarr drops a new
   * movie). The optional `hint.title` skips the paged fallback and asks
   * Jellyfin to do a server-side title search first - much cheaper for large
   * libraries.
   *
   * Why this is shaped the way it is: Jellyfin 10.x silently ignores
   * `AnyProviderIdEquals=tmdb.<id>` and `ProviderIds=Tmdb=<id>` query strings
   * on the `/Items` endpoint - the server returns the entire library
   * regardless of the filter. The original implementation used that filter
   * and returned the first alphabetical movie in the library, which was
   * never the requested one. See issue #126 for the live repro.
   *
   * Strategy:
   * 1. If a title hint is provided, search by `searchTerm=<title>` (which
   *    Jellyfin honours) and client-side filter by ProviderIds.Tmdb.
   * 2. Otherwise (or as a backstop on miss), page through `HasTmdbId=true`
   *    movie items in chunks and client-side filter. Capped at a small page
   *    count to avoid library walks on truly missing entries.
   */
  async findItemByTmdbId(
    tmdbId: number,
    hint?: { title?: string },
  ): Promise<JellyfinItem | null> {
    const wantTmdb = String(tmdbId);

    if (hint?.title && hint.title.trim().length >= 2) {
      const matched = await this.findMovieByTitleSearch(hint.title.trim(), wantTmdb);
      if (matched) return matched;
    }

    return this.findMovieByTmdbIdPaged(wantTmdb);
  }

  private async findMovieByTitleSearch(
    title: string,
    wantTmdb: string,
  ): Promise<JellyfinItem | null> {
    const { userId } = this.requireAuth();
    const params = new URLSearchParams({
      UserId: userId,
      IncludeItemTypes: "Movie",
      Recursive: "true",
      Limit: "20",
      SearchTerm: title,
      Fields: `${ITEM_FIELDS},ProviderIds`,
    });
    const response = await this.fetchAuthed(`${this.baseUrl}/Items?${params}`);
    if (!response.ok) {
      throw new Error(`Jellyfin TMDB lookup (title) failed (${response.status}).`);
    }
    const data = (await response.json()) as JellyfinSearchResponse;
    const match = (data.Items ?? []).find((raw) => raw.ProviderIds?.Tmdb === wantTmdb);
    return match ? this.mapItem(match) : null;
  }

  private async findMovieByTmdbIdPaged(wantTmdb: string): Promise<JellyfinItem | null> {
    const { userId } = this.requireAuth();
    const pageSize = MOVIE_PROVIDER_LOOKUP_PAGE_SIZE;
    const maxPages = MOVIE_PROVIDER_LOOKUP_MAX_PAGES;

    for (let page = 0; page < maxPages; page += 1) {
      const params = new URLSearchParams({
        UserId: userId,
        IncludeItemTypes: "Movie",
        Recursive: "true",
        HasTmdbId: "true",
        StartIndex: String(page * pageSize),
        Limit: String(pageSize),
        Fields: `${ITEM_FIELDS},ProviderIds`,
      });
      const response = await this.fetchAuthed(`${this.baseUrl}/Items?${params}`);
      if (!response.ok) {
        throw new Error(`Jellyfin TMDB lookup (paged) failed (${response.status}).`);
      }
      const data = (await response.json()) as JellyfinSearchResponse;
      const items = data.Items ?? [];
      const match = items.find((raw) => raw.ProviderIds?.Tmdb === wantTmdb);
      if (match) return this.mapItem(match);
      if (items.length < pageSize) return null;
    }
    return null;
  }

  /** Tell Jellyfin to scan all libraries for new files. Idempotent / fire-and-forget. */
  async triggerLibraryRefresh(): Promise<void> {
    const response = await this.fetchAuthed(`${this.baseUrl}/Library/Refresh`, {
      method: "POST",
    });
    if (!response.ok && response.status !== 204) {
      throw new Error(`Jellyfin library refresh failed (${response.status}).`);
    }
  }

  /**
   * Refresh a single item's metadata + media probe. Used after Bazarr drops a
   * new sidecar SRT - that doesn't change the file size so a library refresh
   * may skip it, but a directed item refresh forces Jellyfin to re-read the
   * media streams (and bump dateLastRefreshed, which is what the indexer
   * keys on for incremental decisions).
   *
   * Defaults to Default mode metadata refresh + image refresh, force-replace
   * subtitle/file metadata so Bazarr drops are picked up reliably.
   */
  async refreshItem(itemId: string): Promise<void> {
    const params = new URLSearchParams({
      Recursive: "false",
      MetadataRefreshMode: "Default",
      ImageRefreshMode: "Default",
      ReplaceAllMetadata: "false",
      ReplaceAllImages: "false",
    });
    const response = await this.fetchAuthed(
      `${this.baseUrl}/Items/${encodeURIComponent(itemId)}/Refresh?${params}`,
      { method: "POST" },
    );
    if (!response.ok && response.status !== 204) {
      throw new Error(`Jellyfin item refresh failed (${response.status}).`);
    }
  }

  /**
   * Look up a Jellyfin Series item by TVDB id. Same shape problem as
   * `findItemByTmdbId` - the `AnyProviderIdEquals` filter is silently ignored
   * by Jellyfin 10.x, so we search by title (when provided) and client-side
   * filter on ProviderIds, falling back to a paged walk through
   * `HasTvdbId=true` Series.
   */
  async findSeriesByTvdbId(
    tvdbId: number,
    hint?: { seriesTitle?: string },
  ): Promise<JellyfinItem | null> {
    const wantTvdb = String(tvdbId);

    if (hint?.seriesTitle && hint.seriesTitle.trim().length >= 2) {
      const matched = await this.findSeriesByTitleSearch(hint.seriesTitle.trim(), wantTvdb);
      if (matched) return matched;
    }

    return this.findSeriesByTvdbIdPaged(wantTvdb);
  }

  private async findSeriesByTitleSearch(
    title: string,
    wantTvdb: string,
  ): Promise<JellyfinItem | null> {
    const { userId } = this.requireAuth();
    const params = new URLSearchParams({
      UserId: userId,
      IncludeItemTypes: "Series",
      Recursive: "true",
      Limit: "20",
      SearchTerm: title,
      Fields: `${ITEM_FIELDS},ProviderIds`,
    });
    const response = await this.fetchAuthed(`${this.baseUrl}/Items?${params}`);
    if (!response.ok) {
      throw new Error(`Jellyfin TVDB series lookup (title) failed (${response.status}).`);
    }
    const data = (await response.json()) as JellyfinSearchResponse;
    const match = (data.Items ?? []).find((raw) => raw.ProviderIds?.Tvdb === wantTvdb);
    return match ? this.mapItem(match) : null;
  }

  private async findSeriesByTvdbIdPaged(wantTvdb: string): Promise<JellyfinItem | null> {
    const { userId } = this.requireAuth();
    const pageSize = SERIES_PROVIDER_LOOKUP_PAGE_SIZE;
    const maxPages = SERIES_PROVIDER_LOOKUP_MAX_PAGES;

    for (let page = 0; page < maxPages; page += 1) {
      const params = new URLSearchParams({
        UserId: userId,
        IncludeItemTypes: "Series",
        Recursive: "true",
        HasTvdbId: "true",
        StartIndex: String(page * pageSize),
        Limit: String(pageSize),
        Fields: `${ITEM_FIELDS},ProviderIds`,
      });
      const response = await this.fetchAuthed(`${this.baseUrl}/Items?${params}`);
      if (!response.ok) {
        throw new Error(`Jellyfin TVDB series lookup (paged) failed (${response.status}).`);
      }
      const data = (await response.json()) as JellyfinSearchResponse;
      const items = data.Items ?? [];
      const match = items.find((raw) => raw.ProviderIds?.Tvdb === wantTvdb);
      if (match) return this.mapItem(match);
      if (items.length < pageSize) return null;
    }
    return null;
  }

  /**
   * Look up a Jellyfin Episode by TVDB series id + season + episode numbers.
   * Used after Sonarr drops a new file. Two-step:
   *
   * 1. Resolve the series (`findSeriesByTvdbId`) - works around the
   *    `AnyProviderIdEquals` no-op filter in Jellyfin 10.x.
   * 2. Query episodes scoped to that series with `ParentId=<seriesId>` plus
   *    `ParentIndexNumber=<S>` and `IndexNumber=<E>` - those filters DO work
   *    server-side, so we get the exact row.
   */
  async findEpisodeByTvdb(
    tvdbId: number,
    seasonNumber: number,
    episodeNumber: number,
    hint?: { seriesTitle?: string },
  ): Promise<JellyfinItem | null> {
    const series = await this.findSeriesByTvdbId(tvdbId, hint);
    if (!series) return null;

    const { userId } = this.requireAuth();
    const params = new URLSearchParams({
      UserId: userId,
      ParentId: series.id,
      IncludeItemTypes: "Episode",
      Recursive: "true",
      ParentIndexNumber: String(seasonNumber),
      IndexNumber: String(episodeNumber),
      Limit: "2",
      Fields: ITEM_FIELDS,
    });
    const response = await this.fetchAuthed(`${this.baseUrl}/Items?${params}`);
    if (!response.ok) {
      throw new Error(`Jellyfin episode lookup (S/E) failed (${response.status}).`);
    }
    const data = (await response.json()) as JellyfinSearchResponse;
    const match = (data.Items ?? []).find(
      (raw) =>
        raw.Type === "Episode" &&
        raw.ParentIndexNumber === seasonNumber &&
        raw.IndexNumber === episodeNumber,
    );
    return match ? this.mapItem(match) : null;
  }

  async searchSeries(query: string, limit = 25, signal?: AbortSignal): Promise<JellyfinItem[]> {
    return this.searchItems({
      query,
      includeItemTypes: "Series",
      parentId: this.tvLibraryId,
      limit,
      signal,
    });
  }

  async listSubtitledMedia(params: { startIndex: number; limit: number }): Promise<SubtitledMediaPage> {
    const { userId } = this.requireAuth();
    const searchParams = new URLSearchParams({
      UserId: userId,
      IncludeItemTypes: "Movie,Episode",
      Recursive: "true",
      HasSubtitles: "true",
      StartIndex: String(params.startIndex),
      Limit: String(params.limit),
      Fields: "DateLastRefreshed",
    });

    const response = await this.fetchAuthed(`${this.baseUrl}/Items?${searchParams}`);

    if (!response.ok) {
      throw new Error(`Jellyfin subtitled list failed (${response.status}).`);
    }

    const data = (await response.json()) as JellyfinSearchResponse;
    return {
      total: data.TotalRecordCount ?? 0,
      items: (data.Items ?? []).map((item) => ({
        ...this.mapItem(item),
        dateLastRefreshed: item.DateLastRefreshed,
      })),
    };
  }

  async fetchSubtitleText(
    itemId: string,
    mediaSourceId: string,
    streamIndex: number,
    codec?: string,
  ): Promise<{ content: string; format: "vtt" | "srt" }> {
    const formats: Array<"vtt" | "srt"> =
      codec?.toLowerCase() === "subrip" ? ["srt", "vtt"] : ["vtt", "srt"];

    let lastError: Error | undefined;
    for (const format of formats) {
      const url = `${this.baseUrl}/Videos/${itemId}/${mediaSourceId}/Subtitles/${streamIndex}/Stream.${format}`;
      const response = await this.fetchAuthed(url, {
        headers: { Accept: "text/plain,*/*" },
      });

      if (!response.ok) {
        lastError = new Error(`Subtitle fetch failed (${response.status}) for ${format}.`);
        continue;
      }

      const content = await response.text();
      if (content.trim()) {
        return { content, format };
      }
    }

    throw lastError ?? new Error("Subtitle fetch returned empty content.");
  }

  streamUrl(itemId: string, options?: { mediaSourceId?: string; audioStreamIndex?: number }): string {
    const { accessToken } = this.requireAuth();
    const params = new URLSearchParams({
      static: "true",
      MediaSourceId: options?.mediaSourceId ?? itemId,
      api_key: accessToken,
    });

    if (options?.audioStreamIndex !== undefined) {
      params.set("AudioStreamIndex", String(options.audioStreamIndex));
    }

    return `${this.baseUrl}/Videos/${itemId}/stream?${params}`;
  }

  formatItemLabel(item: JellyfinItem, kind?: MediaKind): string {
    const prefix = kind === "movie" ? "[Movie] " : kind === "tv" ? "[TV] " : "";

    if (item.type === "Episode" && item.seriesName) {
      const season = item.seasonName ? ` / ${item.seasonName}` : "";
      const episodeLabel = formatEpisodeLabel(item);
      return `${prefix}${item.seriesName}${season} - ${episodeLabel}`;
    }

    return `${prefix}${displayTitleWithYear(item)}`;
  }

  private mapItems(data: JellyfinSearchResponse): JellyfinItem[] {
    return (data.Items ?? []).map((item) => this.mapItem(item));
  }

  private async fetchUserItem(itemId: string, fields: string): Promise<JellyfinItemResponse | null> {
    const { userId } = this.requireAuth();
    const searchParams = new URLSearchParams({ Fields: fields });
    const response = await this.fetchAuthed(`${this.baseUrl}/Users/${userId}/Items/${itemId}?${searchParams}`);

    if (response.status === 404 || response.status === 400) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Jellyfin item lookup failed (${response.status}).`);
    }

    return (await response.json()) as JellyfinItemResponse;
  }

  private pickPrimaryMediaSource(sources: JellyfinItemResponse["MediaSources"]): JellyfinMediaSource | null {
    const primary = sources?.[0];
    if (!primary?.Id) return null;

    return {
      id: primary.Id,
      streams: (primary.MediaStreams ?? []).map((stream) => ({
        type: stream.Type,
        index: stream.Index,
        codec: stream.Codec,
        language: stream.Language,
        isDefault: stream.IsDefault,
        isForced: stream.IsForced,
        isTextSubtitleStream: stream.IsTextSubtitleStream,
      })),
    };
  }

  private mapItem(item: JellyfinItemResponse): JellyfinItem {
    return {
      id: item.Id,
      name: item.Name,
      originalTitle: item.OriginalTitle,
      type: item.Type,
      seriesName: item.SeriesName,
      seasonName: item.SeasonName,
      seasonNumber: item.ParentIndexNumber,
      episodeNumber: item.IndexNumber,
      productionYear: item.ProductionYear,
      runtimeTicks: item.RunTimeTicks,
      path: item.Path ?? item.MediaSources?.[0]?.Path,
    };
  }
}

export function formatEpisodeLabel(
  item: Pick<JellyfinItem, "name" | "originalTitle" | "type" | "seasonNumber" | "episodeNumber">,
): string {
  const title = displayTitle(item);
  if (item.seasonNumber != null && item.episodeNumber != null) {
    const season = String(item.seasonNumber).padStart(2, "0");
    const episode = String(item.episodeNumber).padStart(2, "0");
    return `S${season}E${episode} ${title}`;
  }

  return title;
}
