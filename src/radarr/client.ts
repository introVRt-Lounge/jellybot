export type RadarrLookupResult = {
  tmdbId: number;
  imdbId?: string;
  title: string;
  year?: number;
  overview?: string;
  remotePoster?: string;
  runtime?: number;
};

export type RadarrQualityProfile = {
  id: number;
  name: string;
};

export type RadarrRootFolder = {
  id: number;
  path: string;
  freeSpace: number;
  totalSpace?: number;
  accessible?: boolean;
};

export type RadarrMovie = {
  id: number;
  tmdbId: number;
  imdbId?: string;
  title: string;
  year?: number;
  hasFile: boolean;
  monitored: boolean;
  status?: string;
  sizeOnDisk?: number;
  added?: string;
  movieFile?: { path?: string; quality?: { quality?: { name?: string } } };
};

export type RadarrAddMovieInput = {
  tmdbId: number;
  qualityProfileId: number;
  rootFolderPath: string;
  monitored?: boolean;
  searchOnAdd?: boolean;
  minimumAvailability?: "tba" | "announced" | "inCinemas" | "released";
};

export class RadarrClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async systemStatus(): Promise<{ version: string }> {
    return this.request<{ version: string }>("GET", "/api/v3/system/status");
  }

  async lookup(term: string): Promise<RadarrLookupResult[]> {
    const path = `/api/v3/movie/lookup?term=${encodeURIComponent(term)}`;
    const raw = await this.request<RadarrLookupRaw[]>("GET", path);
    return raw
      .filter((row) => Number.isInteger(row.tmdbId))
      .map((row) => ({
        tmdbId: row.tmdbId,
        imdbId: row.imdbId,
        title: row.title,
        year: row.year,
        overview: row.overview,
        remotePoster: row.remotePoster,
        runtime: row.runtime,
      }));
  }

  async qualityProfiles(): Promise<RadarrQualityProfile[]> {
    return this.request<RadarrQualityProfile[]>("GET", "/api/v3/qualityprofile");
  }

  async rootFolders(): Promise<RadarrRootFolder[]> {
    return this.request<RadarrRootFolder[]>("GET", "/api/v3/rootfolder");
  }

  async addMovie(input: RadarrAddMovieInput): Promise<RadarrMovie> {
    const lookup = await this.lookup(`tmdb:${input.tmdbId}`);
    const candidate = lookup.find((c) => c.tmdbId === input.tmdbId);
    if (!candidate) {
      throw new Error(`Radarr lookup returned no results for tmdbId=${input.tmdbId}`);
    }
    const body = {
      tmdbId: candidate.tmdbId,
      title: candidate.title,
      titleSlug: undefined,
      year: candidate.year,
      qualityProfileId: input.qualityProfileId,
      rootFolderPath: input.rootFolderPath,
      monitored: input.monitored ?? true,
      minimumAvailability: input.minimumAvailability ?? "released",
      addOptions: {
        searchForMovie: input.searchOnAdd ?? true,
        monitor: "movieOnly",
      },
    };
    return this.request<RadarrMovie>("POST", "/api/v3/movie", body);
  }

  async getMovie(id: number): Promise<RadarrMovie> {
    return this.request<RadarrMovie>("GET", `/api/v3/movie/${id}`);
  }

  /**
   * Look up an already-added movie by TMDB id. Used to recover the Radarr
   * internal id when addMovie returns 400 with MovieExistsValidator.
   */
  async findMovieByTmdbId(tmdbId: number): Promise<RadarrMovie | null> {
    const path = `/api/v3/movie?tmdbId=${tmdbId}`;
    const matches = await this.request<RadarrMovie[]>("GET", path);
    if (!Array.isArray(matches) || matches.length === 0) return null;
    return matches.find((m) => m.tmdbId === tmdbId) ?? matches[0] ?? null;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
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
      throw new RadarrApiError(
        `Radarr ${method} ${path} returned ${response.status}: ${text.slice(0, 240)}`,
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

export class RadarrApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "RadarrApiError";
  }
}

type RadarrLookupRaw = {
  tmdbId: number;
  imdbId?: string;
  title: string;
  year?: number;
  overview?: string;
  remotePoster?: string;
  runtime?: number;
};
