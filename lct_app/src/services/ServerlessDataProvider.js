import { DataProvider } from './dataProvider';
import { transcribeAudio } from './serverless/sttClient';
import { processTranscriptSegment, generateFullGraph } from './serverless/graphGenerator';
import { saveConversation, saveGraph, getConversation, getGraph, listConversations } from './serverless/indexedDb';

const generateId = () => 'srv_' + Math.random().toString(36).substring(2, 11);

export class ServerlessDataProvider extends DataProvider {
  constructor(apiKey) {
    super();
    this.isServerless = true;
    this.apiKey = apiKey;
    
    this._conversations = {
      fetchNext: async () => {
        // Mock list of conversations
        const convos = await listConversations();
        // Sort descending by date
        convos.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        return {
          json: async () => ({
            items: convos,
            next_url: null,
            total: convos.length
          })
        };
      },
      fetchThreadsData: async (id) => {
        const convo = await getConversation(id);
        const nodes = await getGraph(id) || [];
        if (!convo) throw new Error("Conversation not found");
        return {
          id: convo.id,
          title: convo.title,
          status: convo.status,
          duration_ms: convo.duration_ms,
          created_at: convo.created_at,
          nodes: nodes,
          edges: [] // We don't generate explicit edges yet in phase 1, edge_relations is on nodes
        };
      }
    };

    this._audio = {};
    this._share = {};
    this._subjectReview = {};

    this._import = {
      processFile: async (formData) => {
        const file = formData.get("file");
        if (!file) throw new Error("No file provided");

        // Emit the SAME SSE contract the backend's /api/import/process-file
        // stream speaks: `event: <name>\ndata: <json>\n\n` blocks with event
        // names status/transcript/graph/done/error. The original emitter here
        // wrote bare single-newline NDJSON with its own vocabulary
        // (transcript_update/graph_update/...), which useFileUploadStream
        // could never parse — the serverless upload path ALWAYS ended with
        // "Upload stream ended before completion", regardless of the OpenAI
        // calls succeeding. Caught by the first live e2e run (2026-07-06).
        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            const sendEvent = (name, payload) => {
              controller.enqueue(
                encoder.encode(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
              );
            };

            try {
              const conversationId = formData.get("conversation_id") || generateId();

              // 1. STT Phase
              sendEvent('status', { message: 'Uploading & transcribing audio...', stage: 'transcribing', progress: 0.1 });
              const { text, duration } = await transcribeAudio(apiKey, file);

              sendEvent('transcript', { phase: 'transcribing', text, index: 1, total: 1 });

              // 2. LLM Extraction Phase
              sendEvent('status', { message: 'Extracting conversation threads...', stage: 'analyzing', progress: 0.55 });
              const extractedNodes = await processTranscriptSegment(apiKey, text, []);

              // 3. Hierarchy Consolidation Phase
              sendEvent('status', { message: 'Consolidating conversation hierarchy...', stage: 'analyzing', progress: 0.8 });
              // graphGenerator.generateFullGraph returns {nodes, metadata}, where
              // `nodes` ALREADY includes the extracted tier-1/2 nodes plus the
              // consolidation tiers (themes/arcs). A prior version read
              // `.newNodes`/`.conversation_title` (undefined here — that's
              // consolidateHierarchy's shape), silently dropping the higher
              // tiers and the title.
              const { nodes: allNodes, metadata } = await generateFullGraph(apiKey, extractedNodes);

              // Save to IndexedDB
              await saveConversation({
                id: conversationId,
                title: metadata?.conversation_title || "New Serverless Conversation",
                status: "completed",
                duration_ms: (duration || 0) * 1000,
                executive_summary: metadata?.executive_summary || ""
              });
              await saveGraph(conversationId, allNodes);

              // existing_json is the payload type onDataReceived consumes for
              // a full-graph replace (normalizeGraphDataPayload handles the
              // flat node array).
              sendEvent('graph', { type: 'existing_json', data: allNodes });

              // 4. Finish — `done` is what flips the client's completed flag.
              sendEvent('done', {
                node_count: allNodes.length,
                chunk_count: 1,
                conversation_id: conversationId,
              });
              controller.close();
            } catch (err) {
              sendEvent('error', { message: err?.message || 'Serverless processing failed.', retryable: false });
              controller.close();
            }
          }
        });

        return new Response(stream, {
          headers: { 'Content-Type': 'text/event-stream' }
        });
      }
    };
  }

  get import() { return this._import; }
  
  // Stubs for the rest of the API
  get analytics() { return {}; }
  get artifactSettings() { return {}; }
  get audioRecovery() { return {}; }
  get backendCatalog() { return {}; }
  get bias() { return {}; }
  get byok() { return {}; }
  get consumption() { return {}; }
  get conversationDiagnostics() { return {}; }
  get crux() { return {}; }
  get editHistory() { return {}; }
  get frame() { return {}; }
  get graph() { return {}; }
  get llmSettings() { return {}; }
  get participants() { return {}; }
  get prayerCards() { return {}; }
  get prompts() { return {}; }
  get simulacra() { return {}; }
  get speakerNaming() { return {}; }
  get sttSettings() { return {}; }
  get conversations() { return this._conversations; }
  get audio() { return this._audio; }
  get share() { return this._share; }
  get subjectReview() { return this._subjectReview; }
}
