export type SonarrLookupResult = {
  tvdbId: number;
  imdbId?: string;
  title: string;
  year?: number;
  overview?: string;
  remotePoster?: string;
  status?: string;
  seasons?: SonarrSeasonSummary[];
};

export type SonarrSeasonSummary = {
  seasonNumber: number;
  monitored: boolean;
};

export type SonarrQualityProfile = {
  id: number;
  name: string;
};

export type SonarrLanguageProfile = {
  id: number;
  name: string;
};

export type SonarrRootFolder = {
  id: number;
  path: string;
  freeSpace: number;
  totalSpace?: number;
  accessible?: boolean;
};

export type SonarrSeries = {
  id: number;
  tvdbId: number;
  imdbId?: string;
  title: string;
  year?: number;
  monitored: boolean;
  status?: string;
  path?: string;
  qualityProfileId?: number;
  languageProfileId?: number;
  seasons?: SonarrSeasonSummary[];
  statistics?: { episodeCount?: number; totalEpisodeCount?: number; sizeOnDisk?: number };
  added?: string;
};

export type SonarrEpisode = {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  overview?: string;
  monitored: boolean;
  hasFile: boolean;
  episodeFileId?: number;
  airDate?: string;
};

export type SonarrAddSeriesInput = {
  tvdbId: number;
  qualityProfileId: number;
  /**
   * Sonarr v3 phased out language profiles, but installations that still expose
   * them require a numeric id. Pass when present.
   */
  languageProfileId?: number;
  rootFolderPath: string;
  /** Override the per-call series title (defaults to the lookup title). */
  title?: string;
};

/**
 * Wire-level shape returned by the Sonarr v3 lookup endpoint. Used internally
 * to seed addSeries's payload.
 */
type SonarrLookupRaw = {
  tvdbId: number;
  imdbId?: string;
  title: string;
  titleSlug?: string;
  year?: number;
  overview?: string;
  remotePoster?: string;
  status?: string;
  images?: unknown;
  seasons?: SonarrSeasonSummary[];
};

export class SonarrClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async systemStatus(): Promise<{ version: string }> {
    return this.request<{ version: string }>("GET", "/api/v3/system/status");
  }

  async lookup(term: string): Promise<SonarrLookupResult[]> {
    const path = `/api/v3/series/lookup?term=${encodeURIComponent(term)}`;
    const raw = await this.request<SonarrLookupRaw[]>("GET", path);
    return (raw ?? [])
      .filter((row) => Number.isInteger(row.tvdbId))
      .map((row) => ({
        tvdbId: row.tvdbId,
        imdbId: row.imdbId,
        title: row.title,
        year: row.year,
        overview: row.overview,
        remotePoster: row.remotePoster,
        status: row.status,
        seasons: row.seasons,
      }));
  }

  async qualityProfiles(): Promise<SonarrQualityProfile[]> {
    return this.request<SonarrQualityProfile[]>("GET", "/api/v3/qualityprofile");
  }

  async languageProfiles(): Promise<SonarrLanguageProfile[]> {
    // /languageprofile was removed in newer Sonarr v4; treat 404/410 as "no profiles needed".
    try {
      return await this.request<SonarrLanguageProfile[]>("GET", "/api/v3/languageprofile");
    } catch (error) {
      if (error instanceof SonarrApiError && (error.status === 404 || error.status === 410)) {
        return [];
      }
      throw error;
    }
  }

  async rootFolders(): Promise<SonarrRootFolder[]> {
    return this.request<SonarrRootFolder[]>("GET", "/api/v3/rootfolder");
  }

  async series(): Promise<SonarrSeries[]> {
    return this.request<SonarrSeries[]>("GET", "/api/v3/series");
  }

  async getSeries(id: number): Promise<SonarrSeries> {
    return this.request<SonarrSeries>("GET", `/api/v3/series/${id}`);
  }

  async findSeriesByTvdbId(tvdbId: number): Promise<SonarrSeries | null> {
    const all = await this.series();
    if (!Array.isArray(all)) return null;
    return all.find((s) => s.tvdbId === tvdbId) ?? null;
  }

  /**
   * Add a series to Sonarr WITHOUT grabbing the whole show. The combination
   * `monitored: false` + `addOptions.monitor: "none"` + `searchForMissingEpisodes: false`
   * is what lets us add a parent and then selectively monitor a single
   * episode for download.
   */
  async addSeriesUnmonitored(input: SonarrAddSeriesInput): Promise<SonarrSeries> {
    const lookup = await this.lookup(`tvdb:${input.tvdbId}`);
    const candidate = lookup.find((c) => c.tvdbId === input.tvdbId);
    if (!candidate) {
      throw new SonarrApiError(
        `Sonarr lookup returned no results for tvdbId=${input.tvdbId}`,
        404,
      );
    }

    // We force every season the catalog declares to monitored=false so the
    // built-in season-level autoscan doesn't kick off.
    const seasons = (candidate.seasons ?? []).map((s) => ({
      seasonNumber: s.seasonNumber,
      monitored: false,
    }));

    const body: Record<string, unknown> = {
      tvdbId: candidate.tvdbId,
      title: input.title ?? candidate.title,
      year: candidate.year,
      qualityProfileId: input.qualityProfileId,
      rootFolderPath: input.rootFolderPath,
      monitored: false,
      seasonFolder: true,
      seasons,
      addOptions: {
        monitor: "none",
        searchForMissingEpisodes: false,
        searchForCutoffUnmetEpisodes: false,
      },
    };
    if (input.languageProfileId !== undefined) {
      body.languageProfileId = input.languageProfileId;
    }

    return this.request<SonarrSeries>("POST", "/api/v3/series", body);
  }

  async listEpisodesForSeries(seriesId: number): Promise<SonarrEpisode[]> {
    const path = `/api/v3/episode?seriesId=${seriesId}`;
    return this.request<SonarrEpisode[]>("GET", path);
  }

  async findEpisode(
    seriesId: number,
    seasonNumber: number,
    episodeNumber: number,
  ): Promise<SonarrEpisode | null> {
    const all = await this.listEpisodesForSeries(seriesId);
    if (!Array.isArray(all)) return null;
    return (
      all.find(
        (e) => e.seasonNumber === seasonNumber && e.episodeNumber === episodeNumber,
      ) ?? null
    );
  }

  async getEpisode(id: number): Promise<SonarrEpisode> {
    return this.request<SonarrEpisode>("GET", `/api/v3/episode/${id}`);
  }

  async setEpisodeMonitored(episodeId: number, monitored: boolean): Promise<SonarrEpisode> {
    // Sonarr requires the full episode payload on PUT - fetch first, mutate the
    // monitored flag, send it back. Newer versions also support
    // PUT /episode/monitor with `{ episodeIds, monitored }`, but the
    // single-episode path is broadly compatible.
    const episode = await this.getEpisode(episodeId);
    const updated = { ...episode, monitored };
    return this.request<SonarrEpisode>("PUT", `/api/v3/episode/${episodeId}`, updated);
  }

  /**
   * Issue an EpisodeSearch command for the given episode ids. Sonarr returns
   * 201 with a Command record describing the queued search.
   */
  async episodeSearch(episodeIds: number[]): Promise<{ id?: number; status?: string }> {
    if (episodeIds.length === 0) {
      throw new SonarrApiError("episodeSearch called with empty episodeIds", 400);
    }
    return this.request<{ id?: number; status?: string }>(
      "POST",
      "/api/v3/command",
      { name: "EpisodeSearch", episodeIds },
    );
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        "X-Api-Key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new SonarrApiError(
        `Sonarr ${method} ${path} returned ${response.status}: ${text.slice(0, 240)}`,
        response.status,
      );
    }
    if (response.status === 204) {
      return undefined as T;
    }
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }
}

export class SonarrApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "SonarrApiError";
  }
}
