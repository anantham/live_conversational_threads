import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import YouTubeSourcePanel from "./YouTubeSourcePanel";

// Test intent: source clicks seek; playback and paused/backward scrubs update
// the visible highlight without seeking back. Gaps clear the highlight and
// out-of-node passages remain visible. Unmount stops polling.
let container, root, options, player, time;
const utterances = [
  {id: "a", text: "First sentence", speaker_id: "A", timestamp_start: 10, timestamp_end: 15},
  {id: "b", text: "Second sentence", speaker_id: "B", timestamp_start: 20, timestamp_end: 25},
  {id: "c", text: "Another topic", speaker_id: "A", timestamp_start: 50, timestamp_end: 55},
];
const bundle = {utterances, media_refs: [{provider: "youtube", video_id: "6HmR9IaqM88", view_url: "https://www.youtube.com/watch?v=6HmR9IaqM88", time_unit: "seconds"}]};
const node = {id: "n", utterance_ids: ["a", "b"]};
beforeEach(() => {
  vi.useFakeTimers();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  time = 10;
  player = {getCurrentTime: () => time, seekTo: vi.fn((seconds) => {time = seconds;}), getIframe: () => document.createElement("iframe"), destroy: vi.fn()};
  window.YT = {Player: function (_host, config) {options = config; return player;}};
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); container.remove(); delete window.YT;
  vi.useRealTimers(); globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});
const highlight = () => container.querySelector('[aria-current="true"]')?.textContent;
it("does not rewind when the selected node is cleared",async()=>{
 await act(async()=>root.render(<YouTubeSourcePanel bundle={bundle} node={node} nodes={[node]}/>));
 act(()=>options.events.onReady());
 act(()=>{time=22;vi.advanceTimersByTime(250);});
 const seeks=player.seekTo.mock.calls.length;
 await act(async()=>root.render(<YouTubeSourcePanel bundle={bundle} nodes={[node]}/>));
 expect(time).toBe(22);
 expect(player.seekTo.mock.calls.length).toBe(seeks);
 expect(highlight()).toContain("Second sentence");
});
it("opens with the full transcript and video ready without a node selection",async()=>{
 await act(async()=>root.render(<YouTubeSourcePanel bundle={bundle} nodes={[node]}/>));
 act(()=>options.events.onReady());
 expect(options.playerVars.autoplay).toBe(0);
 expect(player.seekTo).toHaveBeenCalledWith(10,true);
 expect(highlight()).toContain("First sentence");
 expect(container.querySelector('[aria-label="Source passages"]').querySelectorAll('button')).toHaveLength(3);
 expect(container.textContent).not.toContain("Select a node");
 expect(container.textContent).not.toContain("Watch the source");
});
it("allows manual transcript browsing without the playback clock pulling it back",async()=>{
 await act(async()=>root.render(<YouTubeSourcePanel bundle={bundle} nodes={[node]}/>));
 act(()=>options.events.onReady());
 const list=container.querySelector('[aria-label="Source passages"]');
 list.getBoundingClientRect=()=>({top:0,bottom:80,height:80});
 for(const button of list.querySelectorAll('button'))button.getBoundingClientRect=()=>({top:200,bottom:240,height:40});
 act(()=>list.dispatchEvent(new WheelEvent("wheel",{bubbles:true})));
 list.scrollTop=100;
 act(()=>{time=22;vi.advanceTimersByTime(250);});
 expect(list.scrollTop).toBe(100);
 expect(highlight()).toContain("Second sentence");
 act(()=>list.querySelector('[aria-current="true"]').click());
 expect(list.scrollTop).toBeGreaterThan(100);
});
it("highlights start-only imports without creating measured end times", async()=>{
 const starts={...bundle,utterances:utterances.map(({timestamp_end,...u})=>u)};
 await act(async()=>root.render(<YouTubeSourcePanel bundle={starts} node={node} nodes={[node]}/>));
 act(()=>options.events.onReady());
 expect(highlight()).toContain("First sentence");
 act(()=>{time=22;vi.advanceTimersByTime(250);});
 expect(highlight()).toContain("Second sentence");
 expect(starts.utterances[0].timestamp_end).toBeUndefined();
});
it("does not install a timer when player readiness arrives after unmount",async()=>{
 await act(async()=>root.render(<YouTubeSourcePanel bundle={bundle} node={node} nodes={[node]}/>));
 act(()=>root.unmount());
 const remainingTimers=vi.getTimerCount();
 act(()=>options.events.onReady());
 expect(vi.getTimerCount()).toBe(remainingTimers);
 expect(player.destroy).toHaveBeenCalled();
 root=createRoot(container);
});
it("keeps naming and export outside the collapsible transcript",async()=>{
 await act(async()=>root.render(<YouTubeSourcePanel bundle={bundle} node={node} nodes={[node]} onRenameSpeaker={()=>{}}/>));
 const sections=container.querySelectorAll('aside > details');
 expect(sections).toHaveLength(3);
 sections[1].open=false;
 expect(sections[2].querySelector('summary').textContent).toBe("Name the speakers");
 expect(sections[2].textContent).toContain("Download reviewed");
});
it.each([true, false])("synchronizes both ways, compact=%s", async (compact) => {
  await act(async () => root.render(<YouTubeSourcePanel bundle={bundle} node={node} nodes={[node]} compact={compact} />));
  act(() => options.events.onReady());
  expect(highlight()).toContain("First sentence");
  const second = [...container.querySelectorAll('button')].find(b => b.textContent.includes("Second sentence"));
  act(() => second.click());
  expect(time).toBe(20);
  expect(highlight()).toContain("Second sentence");
  const seeks = player.seekTo.mock.calls.length;
  act(() => {time = 12; vi.advanceTimersByTime(250);});
  expect(highlight()).toContain("First sentence");
  act(() => {time = 18; vi.advanceTimersByTime(250);});
  expect(highlight()).toBeUndefined();
  act(() => {time = 52; options.events.onStateChange();});
  expect(highlight()).toContain("Another topic");
  expect(container.textContent).not.toContain("Playing elsewhere");
  expect(container.querySelector('a')).toBeNull();
  expect(player.seekTo.mock.calls.length).toBe(seeks);
  act(() => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  root = createRoot(container);
});

it("offers independent video/transcript collapse and adjustable transcript height", async () => {
  await act(async () => root.render(<YouTubeSourcePanel bundle={bundle} node={node} nodes={[node]} compact />));
  const sections = container.querySelectorAll('aside > details');
  expect(sections).toHaveLength(2);
  expect(sections[0].querySelector('summary').textContent).toBe("Video");
  expect(sections[1].querySelector('summary').textContent).toBe("Transcript");
  sections[0].open = false;
  expect(sections[1].open).toBe(true);
  expect(container.querySelector('[aria-label="Transcript height"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Source passages"]').style.maxHeight).toBe("80px");
});
