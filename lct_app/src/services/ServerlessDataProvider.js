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

        // We will simulate a fetch Response with a ReadableStream
        const stream = new ReadableStream({
          async start(controller) {
            const sendEvent = (type, data) => {
              const str = JSON.stringify({ type, data }) + "\n";
              controller.enqueue(new TextEncoder().encode(str));
            };

            try {
              const conversationId = formData.get("conversation_id") || generateId();
              
              // 1. STT Phase
              sendEvent('status', { message: 'Uploading & Transcribing...', is_final: false });
              const { segments, text, duration } = await transcribeAudio(apiKey, file);
              
              sendEvent('transcript_update', { text, is_final: true });

              // 2. LLM Extraction Phase
              sendEvent('status', { message: 'Extracting conversation threads...', is_final: false });
              const extractedNodes = await processTranscriptSegment(apiKey, text, []);
              
              sendEvent('graph_update', { nodes: extractedNodes });

              // 3. Hierarchy Consolidation Phase
              sendEvent('status', { message: 'Consolidating conversation hierarchy...', is_final: false });
              const finalGraph = await generateFullGraph(apiKey, extractedNodes);

              // Save to IndexedDB
              await saveConversation({
                id: conversationId,
                title: finalGraph.metadata.conversation_title || "New Serverless Conversation",
                status: "completed",
                duration_ms: duration * 1000,
                executive_summary: finalGraph.metadata.executive_summary || ""
              });
              await saveGraph(conversationId, finalGraph.nodes);

              sendEvent('graph_update', finalGraph);
              
              // 4. Finish
              sendEvent('status', { message: 'Done', is_final: true });
              controller.close();
            } catch (err) {
              sendEvent('error', { detail: err.message });
              controller.close();
            }
          }
        });

        return new Response(stream, {
          headers: { 'Content-Type': 'application/x-ndjson' }
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
