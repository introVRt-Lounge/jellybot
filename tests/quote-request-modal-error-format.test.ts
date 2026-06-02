import { describe, expect, test } from "bun:test";
import { formatModalErrorReply } from "../src/quote-requests/handle-modal.ts";
import { RadarrApiError } from "../src/radarr/client.ts";

const skyhook503Body =
  '{"message":"Search for \'Serenity\' failed. Invalid response received from RadarrAPI. Resource temporarily unavailable (api.radarr.video:443)","description":"NzbDrone..."}';

const validation400Body =
  '[{"propertyName":"TmdbId","errorMessage":"This movie has already been added","attemptedValue":16320,"severity":"error","errorCode":"MovieExistsValidator"}]';

describe("formatModalErrorReply", () => {
  test("503 from Radarr surfaces the upstream message and suggests a retry", () => {
    const error = new RadarrApiError(
      `Radarr GET /api/v3/movie/lookup?term=Serenity returned 503: ${skyhook503Body}`,
      503,
    );
    const reply = formatModalErrorReply(error);
    expect(reply).toContain("temporarily unavailable");
    expect(reply).toContain("Try again");
    expect(reply).toContain("Search for 'Serenity'");
  });

  test("502, 504 and 408 also map to the temporarily-unavailable message", () => {
    for (const status of [408, 502, 504]) {
      const reply = formatModalErrorReply(new RadarrApiError(`status ${status}`, status));
      expect(reply).toContain("temporarily unavailable");
    }
  });

  test("401/403 surfaces a maintainer alert", () => {
    expect(formatModalErrorReply(new RadarrApiError("nope", 401))).toContain("auth is misconfigured");
    expect(formatModalErrorReply(new RadarrApiError("nope", 403))).toContain("auth is misconfigured");
  });

  test("400 with an errorMessage surfaces the validation reason", () => {
    const error = new RadarrApiError(
      `Radarr POST /api/v3/movie returned 400: ${validation400Body}`,
      400,
    );
    const reply = formatModalErrorReply(error);
    expect(reply).toContain("Radarr refused this request");
    expect(reply).toContain("already been added");
  });

  test("non-Radarr errors fall back to the generic message", () => {
    expect(formatModalErrorReply(new Error("boom"))).toBe(
      "Something went wrong submitting that request - try again in a minute.",
    );
    expect(formatModalErrorReply("nope")).toBe(
      "Something went wrong submitting that request - try again in a minute.",
    );
  });

  test("other 5xx maps to a Radarr-error message", () => {
    expect(formatModalErrorReply(new RadarrApiError("nope", 500))).toContain("Radarr returned an error");
  });
});
