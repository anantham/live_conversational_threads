import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TranscriptReview from "./TranscriptReview";
import { timedWords } from "./transcriptReviewTiming";
// Public behavior: exact seeking, no invented alignment, durable correction transport,
// retry/undo, view persistence, missing media and cancellation. Synthetic fixtures only.
const api = vi.hoisted(() => ({ fetch: vi.fn(), save: vi.fn() }));
vi.mock("../../services/transcriptReviewApi", () => ({ fetchTranscriptReview: (...a) => api.fetch(...a), correctTranscriptText: (...a) => api.save(...a) }));
const row = { id:"synthetic", text:"Original words", speaker_name:"Synthetic speaker", timestamp_start:2, timestamp_end:5,
  word_timings:[{word:"Original",start:2,end:3},{word:"words",start:4,end:5}] };
const payload={utterances:[row],timing_basis:"recording_relative",graph_refresh_required:false};
let container,root;
const button=(name)=>[...container.querySelectorAll("button")].find((x)=>x.textContent===name);
async function click(element){await act(async()=>element.click());}
async function mount(props={}){await act(async()=>root.render(<TranscriptReview conversationId="synthetic-conversation" visible audioUrl="/synthetic.wav" {...props}/>));}
async function edit(value){await click(button("Edit"));await act(async()=>{const input=container.querySelector("textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});}
beforeEach(()=>{
  globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  api.fetch.mockReset().mockResolvedValue(structuredClone(payload));
  api.save.mockReset().mockImplementation(async(_id,original,text)=>({utterance:{...original,text,word_timings:null},graph_refresh_required:true}));
  vi.spyOn(HTMLMediaElement.prototype,"play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype,"pause").mockImplementation(()=>{});
  vi.spyOn(HTMLMediaElement.prototype,"load").mockImplementation(()=>{});
  vi.spyOn(HTMLMediaElement.prototype,"readyState","get").mockReturnValue(1);
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(()=>{act(()=>root?.unmount());container.remove();vi.restoreAllMocks();vi.useRealTimers();delete globalThis.IS_REACT_ACT_ENVIRONMENT;});
it("seeks real words and excludes silence from highlights",async()=>{
  await mount();await click(container.querySelector('[aria-label="Play word words at 0:04"]'));
  const audio=container.querySelector("audio");expect(audio.currentTime).toBe(4);
  await act(async()=>{audio.currentTime=3.5;audio.dispatchEvent(new Event("timeupdate"));});
  expect(container.querySelectorAll("button.bg-amber-200")).toHaveLength(0);
  await act(async()=>{audio.currentTime=2.5;audio.dispatchEvent(new Event("timeupdate"));});
  expect(container.querySelector("button.bg-amber-200").textContent).toBe("Original");
});
it("uses segment fallback for corrected or incomplete alignment",async()=>{
  expect(timedWords({...row,text:"Corrected words"})).toEqual([]);
  expect(timedWords({...row,word_timings:[{word:"Original words",start:null,end:5}]})).toEqual([]);
  api.fetch.mockResolvedValue({...payload,utterances:[{...row,word_timings:null}]});await mount();
  expect(container.querySelector('[aria-label^="Play word"]')).toBeNull();
  await click(container.querySelector('[aria-label="Play passage at 0:02"]'));expect(container.querySelector("audio").currentTime).toBe(2);
});
it("preserves player and draft across view switching",async()=>{
  await mount();await edit("Unsent correction");const audio=container.querySelector("audio");audio.currentTime=4.2;
  await mount({visible:false});await mount({visible:true});
  expect(container.querySelector("audio")).toBe(audio);expect(audio.currentTime).toBe(4.2);expect(container.querySelector("textarea").value).toBe("Unsent correction");
});
it("saves and undoes through CAS API while clearing old word alignment",async()=>{
  await mount();await edit("Corrected words");await click(button("Save"));
  expect(api.save.mock.calls[0].slice(0,3)).toEqual(["synthetic-conversation",row,"Corrected words"]);
  expect(container.textContent).toContain("Graph summaries and excerpts may need refresh");expect(container.querySelector('[aria-label^="Play word"]')).toBeNull();
  await click(button("Undo"));expect(api.save.mock.calls[1][1].text).toBe("Corrected words");expect(api.save.mock.calls[1][2]).toBe("Original words");
  expect(container.querySelector("article p").textContent).toBe("Original words");
});
it("retains failed drafts for retry and supports Escape",async()=>{
  api.save.mockRejectedValueOnce(new Error("This passage changed. Reload before applying your correction."));
  await mount();await edit("Recoverable correction");await click(button("Save"));
  expect(container.querySelector("textarea").value).toBe("Recoverable correction");expect(container.querySelector('[role="alert"]').textContent).toContain("This passage changed");
  await click(button("Save"));expect(container.querySelector("article p").textContent).toBe("Recoverable correction");
  await edit("Cancelled");await act(async()=>container.querySelector("textarea").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
  expect(container.querySelector("textarea")).toBeNull();expect(api.save).toHaveBeenCalledTimes(2);
});
it("disables seeking without audio or an established caption offset",async()=>{
  await mount({audioUrl:null});expect(container.textContent).toContain("Audio unavailable");expect(container.querySelector('[aria-label^="Play passage"]').disabled).toBe(true);
  api.fetch.mockResolvedValue({...payload,timing_basis:"caption_relative"});await click(button("Reload"));await mount();
  expect(container.textContent).toContain("Caption times are not aligned");expect(container.querySelector('[aria-label^="Play passage"]').disabled).toBe(true);
});
it("shows elapsed pending state and cancels when navigating away",async()=>{
  vi.useFakeTimers();let resolve;api.fetch.mockReturnValue(new Promise((done)=>{resolve=done;}));await mount();
  await act(async()=>vi.advanceTimersByTime(3200));expect(container.textContent).toContain("3s elapsed");expect(container.textContent).toContain("Time remaining unknown");
  const signal=api.fetch.mock.calls[0][1];act(()=>root.unmount());root=null;expect(signal.aborted).toBe(true);await act(async()=>resolve(payload));
});
it("suspends following on manual scroll and pauses playback for editing",async()=>{
  await mount();await act(async()=>container.querySelector('[aria-label="Transcript passages"]').dispatchEvent(new WheelEvent("wheel",{bubbles:true})));
  expect(button("Follow playback").getAttribute("aria-pressed")).toBe("false");await click(button("Follow playback"));expect(button("Following playback")).toBeDefined();
  await click(button("Edit"));expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();expect(button("Follow playback")).toBeDefined();
});

it("does not reset listening position when returning to an already selected graph node",async()=>{
  const node={id:"synthetic-node",timestamp_start:2};
  await mount({visible:false,selectedNode:node});
  const audio=container.querySelector("audio");audio.currentTime=4.5;
  await mount({visible:true,selectedNode:null});await mount({visible:false,selectedNode:node});
  expect(audio.currentTime).toBe(4.5);
});

it("keeps unsaved text when the edit action is invoked again",async()=>{
  await mount();await edit("Keep this draft");
  expect(button("Edit").disabled).toBe(true);await click(button("Edit"));
  expect(container.querySelector("textarea").value).toBe("Keep this draft");
  expect(api.save).not.toHaveBeenCalled();
});

it("keeps malformed stored word alignment readable with segment seeking",async()=>{
  api.fetch.mockResolvedValue({...payload,utterances:[{...row,word_timings:[null]}]});
  await mount();
  expect(container.querySelector("article p").textContent).toBe("Original words");
  expect(container.querySelector('[aria-label^="Play word"]')).toBeNull();
  await click(container.querySelector('[aria-label="Play passage at 0:02"]'));
  expect(container.querySelector("audio").currentTime).toBe(2);
});
