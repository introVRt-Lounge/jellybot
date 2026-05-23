export type MediaKind = "movie" | "tv";

export type JellyfinItem = {
  id: string;
  name: string;
  type: string;
  seriesName?: string;
  seasonName?: string;
  productionYear?: number;
  runtimeTicks?: number;
  path?: string;
};

type JellyfinSearchResponse = {
  Items?: Array<{
    Id: string;
    Name: string;
    Type: string;
    SeriesName?: string;
    SeasonName?: string;
    ProductionYear?: number;
    RunTimeTicks?: number;
    Path?: string;
    MediaSources?: Array<{ Path?: string }>;
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

  private headers(): HeadersInit {
    const { accessToken } = this.requireAuth();
    return {
      "X-Emby-Token": accessToken,
      Accept: "application/json",
    };
  }

  async search(query: string, kind: MediaKind, limit = 25): Promise<JellyfinItem[]> {
    const { userId } = this.requireAuth();
    const params = new URLSearchParams({
      UserId: userId,
      SearchTerm: query,
      IncludeItemTypes: kind === "movie" ? "Movie" : "Episode",
      Recursive: "true",
      Limit: String(limit),
      Fields: "Path,ParentId,SeriesName,SeasonName,ProductionYear,RunTimeTicks",
    });

    if (kind === "movie") {
      params.set(
        "ParentId",
        process.env.JELLYFIN_MOVIES_LIBRARY_ID ?? "f137a2dd21bbc1b99aa5c0f6bf02a805",
      );
    } else {
      params.set(
        "ParentId",
        process.env.JELLYFIN_TV_LIBRARY_ID ?? "a656b907eb3a73532e40e44b968d0225",
      );
    }

    const response = await fetch(`${this.baseUrl}/Items?${params}`, {
      headers: this.headers(),
    });

    if (!response.ok) {
      throw new Error(`Jellyfin search failed (${response.status}).`);
    }

    const data = (await response.json()) as JellyfinSearchResponse;
    return this.mapItems(data);
  }

  async getItem(itemId: string): Promise<JellyfinItem | null> {
    const { userId } = this.requireAuth();

    const response = await fetch(`${this.baseUrl}/Users/${userId}/Items/${itemId}`, {
      headers: this.headers(),
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Jellyfin item lookup failed (${response.status}).`);
    }

    const item = (await response.json()) as JellyfinItemResponse;
    return {
      id: item.Id,
      name: item.Name,
      type: item.Type,
      seriesName: item.SeriesName,
      seasonName: item.SeasonName,
      productionYear: item.ProductionYear,
      runtimeTicks: item.RunTimeTicks,
      path: item.Path ?? item.MediaSources?.[0]?.Path,
    };
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
      return `${prefix}${item.seriesName}${season} - ${item.name}`;
    }

    if (item.productionYear) {
      return `${prefix}${item.name} (${item.productionYear})`;
    }

    return `${prefix}${item.name}`;
  }

  private mapItems(data: JellyfinSearchResponse): JellyfinItem[] {
    return (data.Items ?? []).map((item) => ({
      id: item.Id,
      name: item.Name,
      type: item.Type,
      seriesName: item.SeriesName,
      seasonName: item.SeasonName,
      productionYear: item.ProductionYear,
      runtimeTicks: item.RunTimeTicks,
      path: item.Path ?? item.MediaSources?.[0]?.Path,
    }));
  }
}
