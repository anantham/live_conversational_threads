/* Test intent: public synthetic roster -> caption/PCM WebSocket wire behavior.
 * Real public upstream classes; only the socket is replaced by an in-memory
 * transport. No network/browser/provider/database. Identity comes from explicit
 * parentDeviceId only; unknown IDs are never assigned to a guessed attendee.
 */
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2], 'utf8');
function block(start, end) {
  assert.equal(source.split(start).length, 2, start);
  const text = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  assert.ok(text.length > 100); return text;
}
const classes = block('class CaptionManager {', 'const DEVICE_OUTPUT_TYPE') +
  block('class UserManager {', 'class ReceiverManager {') +
  block('class WebSocketClient {', '// Interceptors');
let sent;
class Socket {
  static OPEN = 1;
  constructor() { this.readyState = 1; }
  send(bytes) { sent.push(Buffer.from(bytes)); }
}
function setup() {
  sent = [];
  const context = vm.createContext({ WebSocket: Socket, TextEncoder, TextDecoder,
    console: { log() {}, error() {} }, window: { initialData: { websocketPort: 0 } } });
  vm.runInContext(classes + `
    const ws = new WebSocketClient();
    const userManager = new UserManager(ws);
    const captionManager = new CaptionManager(ws);
    globalThis.fixture = { ws, userManager, captionManager };
    ws.mediaSendingEnabled = true;
  `, context);
  const f = context.fixture;
  f.userManager.newUsersListSynced([
    { deviceId: 'host-a', fullName: 'Synthetic A', status: 1, isHost: 1 },
    { deviceId: 'host-b', fullName: 'Synthetic B', status: 1 },
    { deviceId: 'bot', fullName: 'Synthetic test bot', status: 1, isCurrentUserString: 'test' },
    { deviceId: 'share-a', fullName: 'Synthetic A presentation', status: 1, parentDeviceId: 'host-a' },
    { deviceId: 'share-a2', fullName: 'Synthetic A second presentation', status: 1, parentDeviceId: 'host-a' },
    { deviceId: 'share-b', fullName: 'Synthetic B presentation', status: 1, parentDeviceId: 'host-b' },
  ]);
  return f;
}
function jsonPackets() { return sent.filter(b => b.readInt32LE(0) === 1).map(b => JSON.parse(b.subarray(4))); }
function captions() { return jsonPackets().filter(x => x.type === 'CaptionUpdate').map(x => x.caption); }
function caption(deviceId, captionId = 7, text = 'Synthetic garden planning', isFinal = 1) {
  return { deviceId, captionId, text, isFinal, version: 1 };
}
function decodeAudio(b) {
  assert.equal(b.readInt32LE(0), 5); const n = b.readUInt8(4);
  return { participant: b.subarray(5, 5 + n).toString(), bytes: b.subarray(5 + n) };
}
const cases = [];
function check(name, body) { cases.push([name, body]); }
check('human roster excludes all presentation devices', () => {
  setup(); const roster = jsonPackets().find(x => x.type === 'UsersUpdate').newUsers;
  assert.deepEqual(roster.map(x => x.deviceId).sort(), ['bot', 'host-a', 'host-b']);
});
check('ordinary microphone caption preserves all fields', () => {
  const f = setup(), original = caption('host-a'); f.captionManager.singleCaptionSynced(original);
  assert.deepEqual(captions()[0], original);
});
check('presentation caption routes to explicit parent', () => {
  const f = setup(); f.captionManager.singleCaptionSynced(caption('share-a'));
  assert.equal(captions()[0].deviceId, 'host-a');
});
check('second presenter never routes to first host', () => {
  const f = setup(); f.captionManager.singleCaptionSynced(caption('share-b'));
  assert.equal(captions()[0].deviceId, 'host-b');
});
check('microphone and two presentations retain distinct source IDs', () => {
  const f = setup(); for (const id of ['host-a', 'share-a', 'share-a2']) f.captionManager.singleCaptionSynced(caption(id));
  const c = captions(); assert.ok(c.every(x => x.deviceId === 'host-a'));
  assert.equal(new Set(c.map(x => String(x.captionId))).size, 3);
});
check('revisions preserve text/final/version and stable caption identity', () => {
  const f = setup(); f.captionManager.singleCaptionSynced(caption('share-a', 7, 'Interim', 0));
  f.captionManager.singleCaptionSynced({ ...caption('share-a', 7, 'Final'), version: 2 });
  const [a,b] = captions(); assert.equal(a.deviceId, 'host-a'); assert.equal(a.captionId, b.captionId);
  assert.equal(a.isFinal, 0); assert.equal(b.isFinal, 1); assert.equal(b.text, 'Final'); assert.equal(b.version, 2);
});
check('input caption remains immutable', () => {
  const f = setup(), c = Object.freeze(caption('share-a'));
  f.captionManager.singleCaptionSynced(c); assert.equal(c.deviceId, 'share-a'); assert.equal(c.captionId, 7);
});
check('presentation PCM wire routes to parent without changing samples', () => {
  const f = setup(), pcm = new Float32Array([0.25, -0.5, 0.75]);
  f.ws.sendPerParticipantAudio('share-a', pcm);
  const wire = decodeAudio(sent.at(-1)); assert.equal(wire.participant, 'host-a');
  assert.deepEqual(wire.bytes, Buffer.from(pcm.buffer));
});
check('ordinary microphone PCM identity stays unchanged', () => {
  const f = setup(); f.ws.sendPerParticipantAudio('host-b', new Float32Array([0.5]));
  assert.equal(decodeAudio(sent.at(-1)).participant, 'host-b');
});
check('unknown source is preserved rather than guessed', () => {
  const f = setup(); f.captionManager.singleCaptionSynced(caption('unknown'));
  f.ws.sendPerParticipantAudio('unknown', new Float32Array([0.5]));
  assert.equal(captions()[0].deviceId, 'unknown'); assert.equal(decodeAudio(sent.at(-1)).participant, 'unknown');
});
check('disabled media forwards neither captions nor PCM', () => {
  const f = setup(); sent.length = 0; f.ws.mediaSendingEnabled = false;
  f.captionManager.singleCaptionSynced(caption('share-a')); f.ws.sendPerParticipantAudio('share-a', new Float32Array([0.5]));
  assert.equal(sent.length, 0);
});
check('closed socket forwards neither captions nor PCM', () => {
  const f = setup(); sent.length = 0; f.ws.ws.readyState = 3;
  f.captionManager.singleCaptionSynced(caption('share-a')); f.ws.sendPerParticipantAudio('share-a', new Float32Array([0.5]));
  assert.equal(sent.length, 0);
});
let failed = 0;
for (const [name, body] of cases) {
  try { body(); console.log(JSON.stringify({ case: name, passed: true })); }
  catch (error) { failed++; console.log(JSON.stringify({ case: name, passed: false, error: error.message })); }
}
console.log(JSON.stringify({ tests: cases.length, failed, synthetic: true, bot_sent: false }));
if (!failed && process.argv[3]) {
  const f = setup();
  for (const id of ['host-a', 'share-a', 'share-a2']) f.captionManager.singleCaptionSynced(caption(id));
  f.ws.sendPerParticipantAudio('share-a', new Float32Array(80000).fill(0.25));
  fs.writeFileSync(process.argv[3], JSON.stringify({ packets: sent.map(b => b.toString('base64')) }), { flag: 'wx' });
}
process.exitCode = failed ? 1 : 0;
