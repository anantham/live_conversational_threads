import { describe, expect, it } from "vitest";
import { buildMediaSeekUrl, mediaOffsetLabel } from "./mediaSeek";

describe("meeting media seek links", () => {
  const ref = {
    provider: "google_drive",
    file_id: "abc_DEF-123",
    view_url: "https://drive.google.com/file/d/abc_DEF-123/view",
  };

  it("adds a two-second preroll to a Drive video link", () => {
    expect(buildMediaSeekUrl(ref, 65.8)).toBe(
      "https://drive.google.com/file/d/abc_DEF-123/view?t=63",
    );
    expect(mediaOffsetLabel(3661)).toBe("1:01:01");
  });

  it("fails closed for unrelated hosts, mismatched ids, or epoch time", () => {
    expect(buildMediaSeekUrl({ ...ref, view_url: "https://example.com/video" }, 10)).toBeNull();
    expect(buildMediaSeekUrl({ ...ref, file_id: "other" }, 10)).toBeNull();
    expect(buildMediaSeekUrl(ref, 1700000000)).toBeNull();
  });
});
