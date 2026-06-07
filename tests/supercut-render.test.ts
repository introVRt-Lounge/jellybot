import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildClipArgs, renderSupercut } from "../src/supercut/render.ts";
import type { SupercutCue } from "../src/supercut/finder.ts";

// Issue #140: render path. Tests verify ffmpeg argument shape and that the
// render pipeline cleans up intermediates on failure. Real ffmpeg is not
// invoked - we inject a fake spawn.

function fakeChild(exitCode: number, stderr = "") {
  const ee = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  setImmediate(() => {
    if (stderr) ee.stderr.emit("data", Buffer.from(stderr));
    ee.emit("close", exitCode);
  });
  return ee;
}

function archerCue(itemId: string, startMs: number, endMs: number, text: string): SupercutCue {
  return {
    itemId,
    itemType: "Episode",
    title: "Movie Star",
    seriesName: "Archer",
    seasonNumber: 2,
    episodeNumber: 7,
    startMs,
    endMs,
    text,
  };
}

describe("buildClipArgs", () => {
  test("emits canonical ffmpeg args with seek, duration, codecs, loudnorm", () => {
    const args = buildClipArgs({
      inputUrl: "https://jellyfin/Items/abc/Stream",
      startSec: 12.345,
      durSec: 4.5,
      outputPath: "/tmp/clip.mp4",
    });

    expect(args).toContain("-ss");
    expect(args[args.indexOf("-ss") + 1]).toBe("12.345");
    expect(args).toContain("-t");
    expect(args[args.indexOf("-t") + 1]).toBe("4.500");
    expect(args).toContain("-i");
    expect(args[args.indexOf("-i") + 1]).toBe("https://jellyfin/Items/abc/Stream");
    expect(args).toContain("-c:v");
    expect(args[args.indexOf("-c:v") + 1]).toBe("libx264");
    expect(args).toContain("-c:a");
    expect(args[args.indexOf("-c:a") + 1]).toBe("aac");
    expect(args).toContain("-af");
    expect(args[args.indexOf("-af") + 1]).toContain("loudnorm");
    expect(args).toContain("-pix_fmt");
    expect(args[args.indexOf("-pix_fmt") + 1]).toBe("yuv420p");
    expect(args[args.length - 1]).toBe("/tmp/clip.mp4");
  });
});

describe("renderSupercut", () => {
  test("returns ok=false with no cues", async () => {
    const result = await renderSupercut({
      cues: [],
      jellyfin: { streamUrl: () => "url" },
      paddingMs: 400,
      workDir: "/tmp/xx",
      outputPath: "/tmp/yy.mp4",
      spawnImpl: (() => fakeChild(0)) as never,
    });
    expect(result.ok).toBe(false);
  });

  test("invokes ffmpeg per-cue then once for concat (3 cues -> 4 ffmpeg calls)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "supercut-test-"));
    const outputPath = join(tmp, "supercut.mp4");
    const calls: string[][] = [];
    const spawnImpl = ((cmd: string, args: string[]) => {
      calls.push(args);
      // Materialise the expected output for the final concat call so
      // fileSizeBytes succeeds. Earlier calls produce per-clip files.
      const last = args[args.length - 1];
      if (last && last.endsWith(".mp4")) writeFileSync(last, Buffer.alloc(2048, 0));
      return fakeChild(0) as never;
    }) as never;

    const cues = [
      archerCue("ep1", 0, 1000, "mawp"),
      archerCue("ep1", 5000, 6000, "mawp"),
      archerCue("ep2", 0, 1000, "mawp"),
    ];

    const result = await renderSupercut({
      cues,
      jellyfin: { streamUrl: (id: string) => `https://jellyfin/Items/${id}/Stream` },
      paddingMs: 400,
      workDir: join(tmp, "work"),
      outputPath,
      spawnImpl,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.clipsRendered).toBe(3);
    }
    // 3 per-cue encodes + 1 concat = 4 total ffmpeg invocations
    expect(calls.length).toBe(4);

    const concatCall = calls[calls.length - 1]!;
    expect(concatCall).toContain("concat");
    expect(concatCall).toContain("copy");
  });

  test("returns ok=false and cleans output when ffmpeg fails", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "supercut-test-"));
    const outputPath = join(tmp, "supercut.mp4");
    let nthCall = 0;
    const spawnImpl = ((_cmd: string, _args: string[]) => {
      nthCall += 1;
      if (nthCall === 2) return fakeChild(1, "ffmpeg: input not found") as never;
      // First call materialises a fake clip so the second call's failure is
      // about the second cue, not a missing file.
      if (nthCall === 1) {
        const out = _args[_args.length - 1];
        if (out && out.endsWith(".mp4")) writeFileSync(out, Buffer.alloc(2048));
      }
      return fakeChild(0) as never;
    }) as never;

    const cues = [archerCue("ep1", 0, 1000, "mawp"), archerCue("ep1", 5000, 6000, "mawp")];

    const result = await renderSupercut({
      cues,
      jellyfin: { streamUrl: () => "https://jellyfin" },
      paddingMs: 400,
      workDir: join(tmp, "work"),
      outputPath,
      spawnImpl,
    });

    expect(result.ok).toBe(false);
    expect(existsSync(outputPath)).toBe(false);
  });
});
