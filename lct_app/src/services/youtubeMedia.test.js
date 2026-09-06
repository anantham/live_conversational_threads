import { describe, expect, it } from "vitest";
import { nodeVideoPassages, renameArtifactSpeaker, selectYouTubeRef, validYouTubeRef, youtubeVideoId } from "./youtubeMedia";
import { buildMediaSeekUrl, mediaOffsetLabel } from "./mediaSeek";

// Test intent: source identity and seconds survive offline export, unrelated
// passages stay separate, missing evidence never produces a fictitious seek.
// Speaker display-name edits preserve source transcript bytes, including when
// no transcript field exists. Valid late passages use the declared seconds
// unit; viewer validation must not inherit the import pipeline's duration cap.
const ref = { provider: "youtube", video_id: "6HmR9IaqM88", view_url: "https://www.youtube.com/watch?v=6HmR9IaqM88", time_unit: "seconds" };
const utterances = [
  { id: "u1", speaker_id: "SPEAKER_00", text: "First", timestamp_start: 1.25, timestamp_end: 4.8 },
  { id: "u2", speaker_id: "SPEAKER_01", text: "Later", timestamp_start: 4900, timestamp_end: 4902 },
  { id: "untimed", timestamp_start: null, timestamp_end: null },
];

describe("YouTube conversation provenance", () => {
  it("accepts single-video URLs but not lookalike hosts or playlists", () => {
    expect(youtubeVideoId("https://youtu.be/6HmR9IaqM88?t=23")).toBe(ref.video_id);
    expect(youtubeVideoId(`${ref.view_url}&list=PLxxx`)).toBeNull();
    expect(youtubeVideoId("https://youtube.com.evil.test/watch?v=6HmR9IaqM88")).toBeNull();
    expect(validYouTubeRef({ ...ref, view_url: "https://evil.test" })).toBe(false);
  });
  it("does not bind a combined/multi-video corpus to an arbitrary recording", () => {
    expect(selectYouTubeRef({ media_refs: [ref] })).toEqual(ref);
    expect(selectYouTubeRef({ combined: {}, media_refs: [ref] })).toBeNull();
    expect(selectYouTubeRef({ media_refs: [ref, ref] })).toBeNull();
  });
  it("keeps an hour-apart parent's passages separate and traverses cyclic descendants safely", () => {
    const parent = { id: "p", children_ids: ["a", "b"] };
    const nodes = [parent, { id: "a", utterance_ids: ["u1"], children_ids: ["p"] }, { id: "b", source_ref: { utterance_ids: ["u2", "untimed"] } }];
    expect(nodeVideoPassages(parent, nodes, utterances)).toEqual(utterances.slice(0, 2));
    expect(nodeVideoPassages({ id: "vague", timestamp_start: 0, timestamp_end: 5000 }, [], utterances)).toEqual([]);
    expect(nodeVideoPassages(utterances[0], [], utterances)).toEqual([utterances[0]]);
  });
  it("rejects missing, nonnumeric, negative, infinite and epoch timestamps", () => {
    for (const invalid of [null, undefined, "", false, "12000", -1, NaN, Infinity, 1700000000]) expect(buildMediaSeekUrl(ref, invalid)).toBeNull();
    expect(mediaOffsetLabel(null)).toBeNull();
    expect(buildMediaSeekUrl(ref, 4900, 0)).toBe(`${ref.view_url}&t=4900s`);
  });
  it("renames one speaker without changing IDs/timestamps and survives JSON export", () => {
    const bundle = { utterances, graph_data: [{ id: "n", speaker_id: "SPEAKER_00" }], media_refs: [ref], full_transcript: "[00:00:01.250] SPEAKER_00: First\r\n[pause]\r\n[01:21:40] SPEAKER_01: Later" };
    const reviewed = JSON.parse(JSON.stringify(renameArtifactSpeaker(bundle, "SPEAKER_00", "Aditya")));
    expect(reviewed.utterances[0]).toMatchObject({ speaker_id: "SPEAKER_00", speaker_name: "Aditya", timestamp_start: 1.25 });
    expect(reviewed.utterances[1]).toEqual(utterances[1]);
    expect(reviewed.full_transcript).toBe(bundle.full_transcript);
    expect(bundle.utterances[0].speaker_name).toBeUndefined();
    expect(selectYouTubeRef(reviewed)).toEqual(ref);
  });
  it("does not manufacture a full transcript when naming a speaker", () => {
    const reviewed = renameArtifactSpeaker({ utterances, graph_data: [] }, "SPEAKER_00", "Test speaker");
    expect(reviewed).not.toHaveProperty("full_transcript");
    expect(reviewed.utterances[0].speaker_name).toBe("Test speaker");
  });
  it("preserves bound passages and seek links beyond three hours", () => {
    const node = { id: "late-node", utterance_ids: ["late", "invalid"] };
    const late = { id: "late", text: "Synthetic late passage", timestamp_start: 12000.25, timestamp_end: 12005 };
    const invalid = { id: "invalid", timestamp_start: 12010, timestamp_end: 12000 };
    expect(nodeVideoPassages(node, [node], [late, invalid])).toEqual([late]);
    expect(buildMediaSeekUrl(ref, late.timestamp_start, 0)).toBe(`${ref.view_url}&t=12000s`);
    expect(mediaOffsetLabel(late.timestamp_start)).toBe("3:20:00");
  });
});
