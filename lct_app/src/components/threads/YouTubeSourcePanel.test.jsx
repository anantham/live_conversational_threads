import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import YouTubeSourcePanel from "./YouTubeSourcePanel";

// Test intent:
// - Source clicks seek; playback and paused/backward scrubs update highlights without seeking back.
// - Speaker names appear beside timestamped context, save by stable speaker ID, and export the reviewed bundle.
// - Transcript passages size and scroll automatically without a height slider; YouTube fallback stays visible.
// - Video and transcript disclosures remain independent; unmount stops polling.
// - Play/Pause is visible outside a ready embed; blocked/stalled embeds never leave an unexplained blank host.
let container, root, options, player, time, playerState;
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
  playerState = -1;
  player = {getPlayerState:()=>playerState, getCurrentTime: () => time, cueVideoById:vi.fn(({startSeconds})=>{time=startSeconds;playerState=5;}), seekTo: vi.fn((seconds) => {time = seconds;if(playerState!==2)playerState=1;}), playVideo:()=>{playerState=1;options.events.onStateChange();}, pauseVideo:()=>{playerState=2;options.events.onStateChange();}, getIframe: () => document.createElement("iframe"), destroy: vi.fn()};
  window.YT = {Player: function (_host, config) {options = config; return player;}};
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); container.remove(); delete window.YT;
  vi.useRealTimers(); globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});
const highlight = () => container.querySelector('[aria-current="true"]')?.textContent;
it.each([5,1,2])("preserves playback state %s on passage and node selection",async(state)=>{
 await act(async()=>root.render(<YouTubeSourcePanel bundle={bundle} nodes={[node]}/>));
 act(()=>options.events.onReady());
 playerState=state;
 act(()=>[...container.querySelectorAll('button')].find(b=>b.textContent.includes('Second sentence')).click());
 expect(time).toBe(20);
 expect(playerState).toBe(state);
 await act(async()=>root.render(<YouTubeSourcePanel bundle={bundle} node={node} nodes={[node]}/>));
 expect(time).toBe(10);
 expect(playerState).toBe(state);
});
it.each([node,{id:"untimed",utterance_ids:[]}])("does not rewind when the selected node is cleared (%j)",async(selected)=>{
 await act(async()=>root.render(<YouTubeSourcePanel bundle={bundle} node={selected} nodes={[selected]}/>));
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
 expect(player.cueVideoById).toHaveBeenCalledWith({videoId:"6HmR9IaqM88",startSeconds:10});
 expect(player.seekTo).not.toHaveBeenCalled();
 expect(highlight()).toContain("First sentence");
 expect(container.querySelector('[aria-label="Source passages"]').querySelectorAll('button')).toHaveLength(3);
 expect(container.querySelector('a[href$="&t=10s"]')?.textContent).toContain("Open on YouTube at");
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
 const starts={...bundle,utterances:utterances.map(u=>{const startOnly={...u};delete startOnly.timestamp_end;return startOnly;})};
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
 const sections=container.querySelectorAll('aside details');
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
  expect(container.querySelector('a[href*="&t="]')).not.toBeNull();
  expect(player.seekTo.mock.calls.length).toBe(seeks);
  act(() => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  root = createRoot(container);
});

it("offers independent video/transcript collapse and automatically sized passage scrolling", async () => {
  await act(async () => root.render(<YouTubeSourcePanel bundle={bundle} node={node} nodes={[node]} compact />));
  const sections = container.querySelectorAll('aside details');
  expect(sections).toHaveLength(2);
  expect(sections[0].querySelector('summary').textContent).toBe("Video");
  expect(sections[1].querySelector('summary').textContent).toBe("Transcript");
  sections[0].open = false;
  expect(sections[1].open).toBe(true);
  expect(container.querySelector('[aria-label="Transcript height"]')).toBeNull();
  expect(container.querySelector('[aria-label="Source passages"]').className).toContain("overflow-y-auto");
  expect(container.querySelector('[aria-label="Source passages"]').style.maxHeight).toBe("");
});

it("reopens the source and seeks in place from an evidence request", async () => {
 await act(async()=>root.render(<YouTubeSourcePanel bundle={bundle} nodes={[node]}/>));
 act(()=>options.events.onReady());
 act(()=>container.querySelector('[aria-label="Hide source panel"]').click());
 expect(container.querySelector('[aria-label="Show source panel"]')).not.toBeNull();
 await act(async()=>root.render(<YouTubeSourcePanel bundle={bundle} nodes={[node]} seekRequest={{seconds:50}}/>));
 expect(container.querySelector('[aria-label="Hide source panel"]')).not.toBeNull();
 expect(time).toBe(50);
 expect(playerState).toBe(5);
 expect(highlight()).toContain("Another topic");
});

it("consumes inline requests and marks the selected node's passages",async()=>{
 const handled=vi.fn();
 await act(async()=>root.render(<YouTubeSourcePanel bundle={bundle} node={node} nodes={[node]} seekRequest={{seconds:20,videoId:'6HmR9IaqM88'}} onSeekHandled={handled}/>));
 act(()=>options.events.onReady());
 expect(handled).toHaveBeenCalledOnce();
 expect(time).toBe(20);
 expect(container.querySelectorAll('[data-node-source="true"]')).toHaveLength(2);
});

it("explains a stalled player, retries at the retained passage, and clears wait timers", async () => {
 await act(async()=>root.render(<YouTubeSourcePanel bundle={bundle} nodes={[node]} seekRequest={{seconds:50}}/>));
 expect(container.querySelector('[role="status"]').textContent).toContain("Preparing the video player");
 expect(container.textContent).toContain("Time remaining unknown");
 act(()=>vi.advanceTimersByTime(20000));
 expect(container.querySelector('[role="alert"]').textContent).toContain("did not become ready");
 await act(async()=>[...container.querySelectorAll('button')].find(button=>button.textContent==="Retry video").click());
 act(()=>options.events.onReady());
 expect(time).toBe(50);
 expect(container.querySelector('[role="alert"]')).toBeNull();
 expect([...container.querySelectorAll('button')].some(button=>button.textContent==="Play video")).toBe(true);
 act(()=>root.unmount());
 // JSDOM queues native details toggle events; flush them before checking application timers.
 act(()=>vi.advanceTimersByTime(1));
 expect(vi.getTimerCount()).toBe(0);
 root=createRoot(container);
});

it("cancels SDK loading when Source closes", async () => {
 delete window.YT;
 await act(async()=>root.render(<YouTubeSourcePanel bundle={bundle} nodes={[node]}/>));
 expect(container.querySelector('[role="status"]').textContent).toContain("Loading YouTube");
 expect(document.querySelector('script[src="https://www.youtube.com/iframe_api"]')).not.toBeNull();
 act(()=>root.unmount());
 expect(document.querySelector('script[src="https://www.youtube.com/iframe_api"]')).toBeNull();
 act(()=>vi.advanceTimersByTime(0));
 expect(vi.getTimerCount()).toBe(0);
 root=createRoot(container);
});

it("retains the observed playback position when retrying an embed failure", async () => {
 await act(async()=>root.render(<YouTubeSourcePanel bundle={bundle} nodes={[node]}/>));
 act(()=>options.events.onReady());
 act(()=>{time=22;vi.advanceTimersByTime(250);options.events.onError();});
 await act(async()=>[...container.querySelectorAll('button')].find(button=>button.textContent==="Retry video").click());
 act(()=>options.events.onReady());
 expect(time).toBe(22);
 expect(highlight()).toContain("Second sentence");
});

it("provides visible Play and Pause at the cued passage, following native state changes",async()=>{
 await act(async()=>root.render(<YouTubeSourcePanel bundle={bundle} nodes={[node]} seekRequest={{seconds:50}}/>));
 expect([...container.querySelectorAll('button')].some(b=>b.textContent==="Play video")).toBe(false);
 act(()=>options.events.onReady());
 const button=()=>[...container.querySelectorAll('button')].find(b=>/^(Play|Pause) video$/.test(b.textContent));
 expect(button().textContent).toBe("Play video");
 act(()=>button().click());
 expect(time).toBe(50);
 expect(playerState).toBe(1);
 expect(button().textContent).toBe("Pause video");
 act(()=>button().click());
 expect(playerState).toBe(2);
 expect(button().textContent).toBe("Play video");
 act(()=>{playerState=1;options.events.onStateChange();});
 expect(button().textContent).toBe("Pause video");
});

it("keeps a timed-out embed failed even if it reports late readiness",async()=>{
 await act(async()=>root.render(<YouTubeSourcePanel bundle={bundle} nodes={[node]} seekRequest={{seconds:50}}/>));
 act(()=>vi.advanceTimersByTime(20000));
 expect(container.querySelector('[role="alert"]').textContent).toContain("did not become ready");
 act(()=>options.events.onReady());
 expect(container.querySelector('[role="alert"]').textContent).toContain("did not become ready");
 expect(container.querySelector('a').href).toContain("&t=50s");
 expect([...container.querySelectorAll('button')].some(b=>b.textContent==="Play video")).toBe(false);
 expect(player.destroy).toHaveBeenCalledOnce();
});

it("explains blocked playback with a usable recording link",async()=>{
 await act(async()=>root.render(<YouTubeSourcePanel bundle={bundle} nodes={[node]}/>));
 act(()=>options.events.onReady());
 act(()=>options.events.onAutoplayBlocked());
 expect(container.querySelector('[role="alert"]').textContent).toContain("browser blocked playback");
 expect(container.querySelector('a').href).toContain("&t=10s");
 act(()=>{playerState=1;options.events.onStateChange();});
 expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("shows elapsed time when Play stalls, stops waiting, and cleans up on close",async()=>{
 player.playVideo=()=>{};
 await act(async()=>root.render(<YouTubeSourcePanel bundle={bundle} nodes={[node]}/>));
 act(()=>options.events.onReady());
 act(()=>[...container.querySelectorAll('button')].find(b=>b.textContent==="Play video").click());
 expect([...container.querySelectorAll('button')].find(b=>b.textContent==="Play video").disabled).toBe(true);
 expect(container.querySelector('[role="status"]').textContent).toBe("Starting playback");
 act(()=>vi.advanceTimersByTime(2000));
 expect(container.textContent).toContain("2s elapsed · Time remaining unknown");
 act(()=>vi.advanceTimersByTime(18000));
 expect(container.querySelector('[role="alert"]').textContent).toContain("taking longer than expected");
 expect(container.querySelector('[role="status"]')).toBeNull();
 expect([...container.querySelectorAll('button')].find(b=>b.textContent==="Play video").disabled).toBe(false);
 act(()=>root.unmount());
 act(()=>vi.advanceTimersByTime(1));
 expect(vi.getTimerCount()).toBe(0);
 root=createRoot(container);
});
