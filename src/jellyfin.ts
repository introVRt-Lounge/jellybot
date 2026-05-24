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
const DEFAULT_MOVIES_LIBRARY_ID = "f137a2dd21bbc1b99aa5c0f6bf02a805";
const DEFAULT_TV_LIBRARY_ID = "a656b907eb3a73532e40e44b968d0225";
const TV_SERIES_EXPAND_LIMIT = 3;
const TV_EPISODES_PER_SERIES = 25;

export type EpisodeListOptions = {
  limit: number;
  query?: string;
};

export function isJellyfinItemId(value: string): boolean {
  return JELLYFIN_ITEM_ID_PATTERN.test(value.trim());
}

export type TvSearchExpandOptions = {
  maxSeriesToExpand: number;
  episodesPerSeries: number;
  totalLimit: number;
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
    const remaining = options.totalLimit - expanded.length;
    if (remaining <= 0) break;

    const showEpisodes = await listEpisodesForSeries(show.id, {
      limit: Math.min(options.episodesPerSeries, remaining),
      query,
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

export class JellyfinClient {
  private accessToken?: string;
  private userId?: string;
  private username?: string;

  constructor(
    private readonly baseUrl: string,
    private readonly usernameInput: string,
    private readonly password: string,
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

  async search(query: string, kind: MediaKind, limit = 25): Promise<JellyfinItem[]> {
    if (kind === "movie") {
      return this.searchItems({
        query,
        includeItemTypes: "Movie",
        parentId: process.env.JELLYFIN_MOVIES_LIBRARY_ID ?? DEFAULT_MOVIES_LIBRARY_ID,
        limit,
      });
    }

    return this.searchTv(query, limit);
  }

  private async searchTv(query: string, limit: number): Promise<JellyfinItem[]> {
    const parentId = process.env.JELLYFIN_TV_LIBRARY_ID ?? DEFAULT_TV_LIBRARY_ID;
    const parsed = parseTvMediaQuery(query);
    const seriesQuery = parsed.seriesText.length >= 2 ? parsed.seriesText : query;

    const [episodes, series] = await Promise.all([
      this.searchItems({
        query,
        includeItemTypes: "Episode",
        parentId,
        limit,
      }),
      this.searchItems({
        query: seriesQuery,
        includeItemTypes: "Series",
        parentId,
        limit: TV_SERIES_EXPAND_LIMIT,
      }),
    ]);

    return resolveTvSearchResults(
      episodes,
      series,
      query,
      (seriesId, options) => this.listEpisodesForSeries(seriesId, options),
      {
        maxSeriesToExpand: TV_SERIES_EXPAND_LIMIT,
        episodesPerSeries: TV_EPISODES_PER_SERIES,
        totalLimit: limit,
      },
    );
  }

  private async searchItems(params: {
    query: string;
    includeItemTypes: string;
    parentId: string;
    limit: number;
  }): Promise<JellyfinItem[]> {
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

    const response = await this.fetchAuthed(`${this.baseUrl}/Items?${searchParams}`);

    if (!response.ok) {
      throw new Error(`Jellyfin search failed (${response.status}).`);
    }

    const data = (await response.json()) as JellyfinSearchResponse;
    return this.mapItems(data);
  }

  private async listEpisodesForSeries(seriesId: string, options: EpisodeListOptions): Promise<JellyfinItem[]> {
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

    let items = await this.fetchEpisodeItems(searchParams);
    if (items.length === 0 && searchTerm.length >= 2 && !hasIndexHint) {
      searchParams.delete("SearchTerm");
      items = await this.fetchEpisodeItems(searchParams);
    }

    return items;
  }

  private async fetchEpisodeItems(searchParams: URLSearchParams): Promise<JellyfinItem[]> {
    const response = await this.fetchAuthed(`${this.baseUrl}/Items?${searchParams}`);

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

  async countSubtitledMedia(): Promise<number> {
    const { userId } = this.requireAuth();
    const searchParams = new URLSearchParams({
      UserId: userId,
      IncludeItemTypes: "Movie,Episode",
      Recursive: "true",
      HasSubtitles: "true",
      Limit: "1",
    });

    const response = await this.fetchAuthed(`${this.baseUrl}/Items?${searchParams}`);

    if (!response.ok) {
      throw new Error(`Jellyfin subtitled count failed (${response.status}).`);
    }

    const data = (await response.json()) as JellyfinSearchResponse;
    return data.TotalRecordCount ?? 0;
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

  streamUrl(itemId: string): string {
    const { accessToken } = this.requireAuth();
    const params = new URLSearchParams({
      static: "true",
      MediaSourceId: itemId,
      api_key: accessToken,
    });

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
