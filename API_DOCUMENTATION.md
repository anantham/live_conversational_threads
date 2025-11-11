# API Documentation

Complete reference for the Live Conversational Threads backend API.

**Base URL**: `http://localhost:8080`
**API Version**: 1.0
**Format**: JSON
**Authentication**: None (API keys configured via environment variables)

---

## Table of Contents
- [Quick Reference](#quick-reference)
- [Data Models](#data-models)
- [REST API Endpoints](#rest-api-endpoints)
  - [Transcript Processing](#transcript-processing)
  - [Conversation Management](#conversation-management)
  - [Formalism Generation](#formalism-generation)
  - [Fact Checking](#fact-checking)
- [WebSocket Endpoints](#websocket-endpoints)
- [Error Handling](#error-handling)
- [Rate Limiting](#rate-limiting)
- [Examples](#examples)

---

## Quick Reference

| Endpoint | Method | Purpose | Request Body | Response |
|----------|--------|---------|--------------|----------|
| `/get_chunks/` | POST | Chunk transcript | `TranscriptRequest` | `ChunkedTranscript` |
| `/generate-context-stream/` | POST | Analyze conversation | `ChunkedRequest` | Server-Sent Events |
| `/save_json/` | POST | Save conversation | `SaveJsonRequest` | `SaveJsonResponse` |
| `/generate_formalism/` | POST | Generate formalism | `generateFormalismRequest` | `generateFormalismResponse` |
| `/conversations/` | GET | List conversations | None | `List[SaveJsonResponseExtended]` |
| `/conversations/{id}` | GET | Get conversation | Path param | `ConversationResponse` |
| `/fact_check_claims/` | POST | Fact-check claims | `FactCheckRequest` | `ClaimsResponse` |
| `/ws/audio` | WebSocket | Audio transcription | Binary audio | Text transcription |

---

## Data Models

### Request Models

#### TranscriptRequest
```json
{
  "transcript": "string"  // Full conversation transcript
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `transcript` | string | Yes | Full text of the conversation to be processed |

---

#### ChunkedRequest
```json
{
  "chunks": {
    "uuid-1": "chunk text 1",
    "uuid-2": "chunk text 2"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chunks` | Dict[str, str] | Yes | Dictionary of chunk UUIDs to chunk text |

---

#### SaveJsonRequest
```json
{
  "file_name": "my_conversation",
  "chunks": {
    "uuid-1": "chunk text"
  },
  "graph_data": [
    {
      "node_name": "node_1",
      "node_type": "conversational_thread",
      "summary": "Discussion about AI",
      "predecessor_nodes": [],
      "successor_nodes": ["node_2"],
      "linked_nodes": [],
      "is_bookmark": false
    }
  ],
  "conversation_id": "conv-uuid-123"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file_name` | string | Yes | Name for the saved conversation |
| `chunks` | dict | Yes | Original transcript chunks |
| `graph_data` | List | Yes | Conversation graph nodes and relationships |
| `conversation_id` | string | Yes | Unique conversation identifier (UUID) |

**Graph Data Node Structure:**
```typescript
{
  node_name: string,                    // Unique node identifier
  node_type: "conversational_thread" | "bookmark",
  summary: string,                      // Node content summary
  predecessor_nodes: string[],          // Previous nodes in flow
  successor_nodes: string[],            // Next nodes in flow
  linked_nodes: string[],               // Related nodes
  contextual_relations: string[],       // Contextual connections
  is_bookmark: boolean,                 // Bookmark status
  contextual_progress?: string          // Progress indicator (optional)
}
```

---

#### generateFormalismRequest
```json
{
  "chunks": {
    "uuid-1": "chunk text"
  },
  "graph_data": [...],
  "user_pref": "I am researching system dynamics and causal relationships"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chunks` | dict | Yes | Transcript chunks |
| `graph_data` | List | Yes | Conversation graph data |
| `user_pref` | string | Yes | User's research context/preferences |

---

#### FactCheckRequest
```json
{
  "claims": [
    "The Earth is round",
    "Water boils at 100°C at sea level"
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `claims` | List[string] | Yes | List of claims to fact-check |

---

### Response Models

#### ChunkedTranscript
```json
{
  "chunks": {
    "550e8400-e29b-41d4-a716-446655440000": "This is chunk 1 text...",
    "550e8400-e29b-41d4-a716-446655440001": "This is chunk 2 text..."
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `chunks` | Dict[str, str] | UUID-to-text mapping of chunks |

---

#### SaveJsonResponse
```json
{
  "message": "JSON saved successfully to GCS",
  "file_id": "550e8400-e29b-41d4-a716-446655440000",
  "file_name": "my_conversation"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `message` | string | Success/failure message |
| `file_id` | string | UUID of the saved conversation |
| `file_name` | string | User-provided file name |

---

#### generateFormalismResponse
```json
{
  "formalism_data": [
    {
      "variable_name": "AI Development",
      "connections": [
        {
          "target": "Data Quality",
          "relationship": "positive",
          "strength": "strong"
        }
      ]
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `formalism_data` | List | Causal loop diagram structure |

---

#### SaveJsonResponseExtended
```json
{
  "file_id": "550e8400-e29b-41d4-a716-446655440000",
  "file_name": "my_conversation",
  "message": "Success",
  "no_of_nodes": 15,
  "created_at": "2025-01-10T12:00:00Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `file_id` | string | Conversation UUID |
| `file_name` | string | Conversation name |
| `message` | string | Status message |
| `no_of_nodes` | int | Number of conversation nodes |
| `created_at` | string (ISO 8601) | Creation timestamp |

---

#### ConversationResponse
```json
{
  "graph_data": [...],
  "chunk_dict": {
    "uuid-1": "chunk text"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `graph_data` | List[Any] | Complete conversation graph structure |
| `chunk_dict` | Dict[str, Any] | Original transcript chunks |

---

#### ClaimsResponse
```json
{
  "claims": [
    {
      "claim": "The Earth is round",
      "verdict": "True",
      "explanation": "Scientific consensus supports this claim...",
      "citations": [
        {
          "title": "NASA Earth Observations",
          "url": "https://nasa.gov/earth"
        }
      ]
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `claims` | List[AnswerFormat] | Fact-check results for each claim |

**AnswerFormat Structure:**
```typescript
{
  claim: string,                    // Original claim text
  verdict: "True" | "False" | "Unverified",
  explanation: string,              // Detailed explanation
  citations: [                      // Max 2 preferred
    {
      title: string,
      url: string (valid URL)
    }
  ]
}
```

---

## REST API Endpoints

### Transcript Processing

#### POST `/get_chunks/`

**Purpose**: Split a large transcript into manageable chunks using sliding window algorithm.

**Request Body**: `TranscriptRequest`
```json
{
  "transcript": "This is a very long conversation transcript..."
}
```

**Response**: `ChunkedTranscript` (200 OK)
```json
{
  "chunks": {
    "uuid-1": "First chunk of text...",
    "uuid-2": "Second chunk with overlap..."
  }
}
```

**Algorithm Details**:
- **Chunk Size**: 10,000 words (default)
- **Overlap**: 2,000 words (maintains context continuity)
- **UUID**: Each chunk assigned unique identifier

**Example**:
```bash
curl -X POST http://localhost:8080/get_chunks/ \
  -H "Content-Type: application/json" \
  -d '{"transcript": "Your full transcript here..."}'
```

**Error Responses**:
- `400 Bad Request` - Invalid transcript format
- `500 Internal Server Error` - Processing error

---

#### POST `/generate-context-stream/`

**Purpose**: Analyze conversation chunks and stream back structured graph data in real-time.

**Request Body**: `ChunkedRequest`
```json
{
  "chunks": {
    "uuid-1": "chunk text 1",
    "uuid-2": "chunk text 2"
  }
}
```

**Response**: Server-Sent Events (SSE)

**Stream Format**:
```
data: {"node_name": "node_1", "node_type": "conversational_thread", ...}

data: {"node_name": "node_2", "node_type": "conversational_thread", ...}

data: [DONE]
```

**Processing**:
- Uses Anthropic Claude for conversation analysis
- Identifies threads, bookmarks, and relationships
- Streams results as they're processed
- Handles up to 12 concurrent chunk batches

**Example**:
```javascript
const eventSource = new EventSource('http://localhost:8080/generate-context-stream/');

eventSource.onmessage = (event) => {
  if (event.data === '[DONE]') {
    eventSource.close();
    return;
  }
  const node = JSON.parse(event.data);
  console.log('Received node:', node);
};
```

**Configuration**:
- **Batch Size**: 4 chunks (adjustable up to 12)
- **Model**: Claude Sonnet 3.5
- **Timeout**: None (streams until complete)

---

### Conversation Management

#### POST `/save_json/`

**Purpose**: Save conversation graph data to Google Cloud Storage and metadata to PostgreSQL.

**Request Body**: `SaveJsonRequest`
```json
{
  "file_name": "my_research_conversation",
  "chunks": {...},
  "graph_data": [...],
  "conversation_id": "conv-123"
}
```

**Response**: `SaveJsonResponse` (200 OK)
```json
{
  "message": "JSON saved successfully to GCS",
  "file_id": "conv-123",
  "file_name": "my_research_conversation"
}
```

**Storage Locations**:
- **GCS**: `gs://{bucket}/{folder}/{file_name}.json`
- **PostgreSQL**: Metadata in `conversations` table

**Database Record**:
```sql
id: "conv-123"
file_name: "my_research_conversation"
no_of_nodes: 15
gcs_path: "gs://bucket/folder/my_research_conversation.json"
created_at: "2025-01-10T12:00:00Z"
```

**Example**:
```bash
curl -X POST http://localhost:8080/save_json/ \
  -H "Content-Type: application/json" \
  -d '{
    "file_name": "test_conv",
    "chunks": {},
    "graph_data": [],
    "conversation_id": "test-123"
  }'
```

**Error Responses**:
- `400 Bad Request` - Invalid request data
- `500 Internal Server Error` - GCS or database error

---

#### GET `/conversations/`

**Purpose**: Retrieve list of all saved conversations, ordered by creation date (newest first).

**Request**: No body required

**Response**: `List[SaveJsonResponseExtended]` (200 OK)
```json
[
  {
    "file_id": "conv-123",
    "file_name": "Research Discussion",
    "message": "Retrieved from database",
    "no_of_nodes": 15,
    "created_at": "2025-01-10T12:00:00Z"
  },
  {
    "file_id": "conv-124",
    "file_name": "Team Meeting",
    "message": "Retrieved from database",
    "no_of_nodes": 8,
    "created_at": "2025-01-09T10:30:00Z"
  }
]
```

**Sorting**: Conversations sorted by `created_at` DESC

**Example**:
```bash
curl http://localhost:8080/conversations/
```

**Error Responses**:
- `500 Internal Server Error` - Database connection error

---

#### GET `/conversations/{conversation_id}`

**Purpose**: Fetch complete conversation data including graph structure and chunks.

**Path Parameters**:
- `conversation_id` (string): UUID of the conversation

**Response**: `ConversationResponse` (200 OK)
```json
{
  "graph_data": [
    {
      "node_name": "node_1",
      "summary": "Discussion about AI",
      ...
    }
  ],
  "chunk_dict": {
    "uuid-1": "Original transcript chunk..."
  }
}
```

**Process**:
1. Query PostgreSQL for GCS path
2. Fetch JSON file from GCS
3. Parse and return graph data + chunks

**Example**:
```bash
curl http://localhost:8080/conversations/conv-123
```

**Error Responses**:
- `404 Not Found` - Conversation ID doesn't exist
- `500 Internal Server Error` - GCS retrieval error

---

### Formalism Generation

#### POST `/generate_formalism/`

**Purpose**: Generate causal loop diagram (formalism) from conversation data.

**Request Body**: `generateFormalismRequest`
```json
{
  "chunks": {...},
  "graph_data": [...],
  "user_pref": "I'm researching climate change feedback loops"
}
```

**Response**: `generateFormalismResponse` (200 OK)
```json
{
  "formalism_data": [
    {
      "variable_name": "CO2 Emissions",
      "connections": [
        {
          "target": "Global Temperature",
          "relationship": "positive",
          "strength": "strong"
        },
        {
          "target": "Ice Melt",
          "relationship": "positive",
          "strength": "medium"
        }
      ]
    }
  ]
}
```

**AI Processing**:
- **Model**: Google Gemini 2.0 Flash
- **Context**: Uses user preferences to customize formalism
- **Output**: System dynamics causal loop structure

**Formalism Structure**:
```typescript
{
  variable_name: string,         // Node in causal system
  connections: [
    {
      target: string,            // Connected variable
      relationship: "positive" | "negative",
      strength: "weak" | "medium" | "strong"
    }
  ]
}
```

**Example**:
```bash
curl -X POST http://localhost:8080/generate_formalism/ \
  -H "Content-Type: application/json" \
  -d '{
    "chunks": {},
    "graph_data": [],
    "user_pref": "Systems thinking perspective"
  }'
```

**Error Responses**:
- `400 Bad Request` - Invalid graph data
- `500 Internal Server Error` - AI service error

---

### Fact Checking

#### POST `/fact_check_claims/`

**Purpose**: Verify factual claims using Perplexity AI.

**Request Body**: `FactCheckRequest`
```json
{
  "claims": [
    "Python was created in 1991",
    "The speed of light is 300,000 km/s"
  ]
}
```

**Response**: `ClaimsResponse` (200 OK)
```json
{
  "claims": [
    {
      "claim": "Python was created in 1991",
      "verdict": "True",
      "explanation": "Python was indeed first released by Guido van Rossum in 1991...",
      "citations": [
        {
          "title": "Python History",
          "url": "https://www.python.org/about/"
        }
      ]
    },
    {
      "claim": "The speed of light is 300,000 km/s",
      "verdict": "True",
      "explanation": "The speed of light in vacuum is approximately 299,792 km/s...",
      "citations": [
        {
          "title": "NIST Speed of Light",
          "url": "https://physics.nist.gov/"
        }
      ]
    }
  ]
}
```

**Verdict Options**:
- `"True"` - Claim verified as accurate
- `"False"` - Claim contradicted by evidence
- `"Unverified"` - Insufficient evidence to determine

**AI Processing**:
- **Service**: Perplexity AI
- **Model**: Sonar model with citations
- **Limit**: Max 2 citations per claim (preferred)

**Example**:
```bash
curl -X POST http://localhost:8080/fact_check_claims/ \
  -H "Content-Type: application/json" \
  -d '{
    "claims": ["The Earth orbits the Sun"]
  }'
```

**Error Responses**:
- `400 Bad Request` - Empty or invalid claims list
- `500 Internal Server Error` - Perplexity API error

---

## WebSocket Endpoints

### WS `/ws/audio`

**Purpose**: Real-time audio transcription via AssemblyAI.

**Protocol**: WebSocket

**Connection URL**: `ws://localhost:8080/ws/audio`

**Message Flow**:

```
Client                          Backend                     AssemblyAI
  |                                |                              |
  |--- connect ------------------>|                              |
  |                                |--- connect ---------------->|
  |<-- "connection_established" ---|                              |
  |                                |                              |
  |--- audio binary data --------->|                              |
  |                                |--- audio binary ----------->|
  |                                |<-- transcript --------------|
  |<-- {"text": "hello"} ----------|                              |
  |                                |                              |
  |--- audio binary data --------->|                              |
  |<-- {"text": "world"} ----------|                              |
  |                                |                              |
  |--- close -------------------->|                              |
  |                                |--- close ------------------>|
```

**Client → Server Messages**:
```javascript
// Binary audio data (16kHz sample rate recommended)
const audioBlob = new Blob([audioData], { type: 'audio/wav' });
websocket.send(await audioBlob.arrayBuffer());
```

**Server → Client Messages**:
```json
// Connection established
{"type": "connection_established"}

// Transcription result
{
  "text": "transcribed speech",
  "confidence": 0.95,
  "is_final": true
}

// Error
{
  "type": "error",
  "message": "AssemblyAI connection failed"
}
```

**Audio Requirements**:
- **Format**: Raw audio binary (PCM)
- **Sample Rate**: 16kHz (recommended)
- **Channels**: Mono
- **Bit Depth**: 16-bit

**Example (JavaScript)**:
```javascript
const ws = new WebSocket('ws://localhost:8080/ws/audio');

ws.onopen = () => {
  console.log('Connected to transcription service');

  // Send audio data
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(stream => {
      const mediaRecorder = new MediaRecorder(stream);

      mediaRecorder.ondataavailable = (event) => {
        ws.send(event.data);
      };

      mediaRecorder.start(100); // Send chunks every 100ms
    });
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Transcription:', data.text);
};

ws.onerror = (error) => {
  console.error('WebSocket error:', error);
};
```

**Error Handling**:
- Connection failures logged and reported
- Automatic reconnection NOT implemented (client responsibility)
- Backend maintains connection to AssemblyAI throughout session

---

## Error Handling

### Standard Error Response Format

```json
{
  "detail": "Error description",
  "status_code": 400,
  "error_type": "ValidationError"
}
```

### HTTP Status Codes

| Code | Meaning | Usage |
|------|---------|-------|
| 200 | OK | Successful request |
| 400 | Bad Request | Invalid request data |
| 404 | Not Found | Resource doesn't exist |
| 500 | Internal Server Error | Server-side error |
| 503 | Service Unavailable | External service failure |

### Common Error Scenarios

**Invalid JSON:**
```json
{
  "detail": "Invalid JSON format"
}
```

**Missing Required Fields:**
```json
{
  "detail": "Field 'transcript' is required"
}
```

**Database Connection Error:**
```json
{
  "detail": "Could not connect to database",
  "status_code": 500
}
```

**GCS Upload Failure:**
```json
{
  "detail": "Failed to upload to Google Cloud Storage",
  "status_code": 500
}
```

**AI Service Error:**
```json
{
  "detail": "Anthropic API error: Rate limit exceeded",
  "status_code": 503
}
```

---

## Rate Limiting

⚠️ **WARNING**: Rate limiting is **NOT currently implemented**.

### Current Limitations
- No request throttling
- No API key-based limits
- External services (Claude, AssemblyAI, etc.) have their own rate limits

### External Service Limits

**Anthropic Claude:**
- Varies by API tier
- Check: https://docs.anthropic.com/en/api/rate-limits

**AssemblyAI:**
- Concurrent WebSocket connections limited by plan
- Check: https://www.assemblyai.com/docs

**Perplexity AI:**
- API rate limits apply
- Check: https://docs.perplexity.ai/

**Google Gemini:**
- Requests per minute/day limits
- Check: https://ai.google.dev/gemini-api/docs/quota

### Recommended Implementation
```python
# Future rate limiting (not implemented)
from fastapi import HTTPException
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)

@lct_app.post("/get_chunks/")
@limiter.limit("10/minute")
async def get_chunks(request: TranscriptRequest):
    # ... implementation
```

---

## Examples

### Complete Workflow: Create and Save Conversation

```python
import requests
import json

BASE_URL = "http://localhost:8080"

# Step 1: Chunk transcript
transcript = "This is my research conversation about AI and its impact on society..."

chunks_response = requests.post(
    f"{BASE_URL}/get_chunks/",
    json={"transcript": transcript}
)
chunks = chunks_response.json()["chunks"]

# Step 2: Generate conversation graph (using SSE)
import sseclient

response = requests.post(
    f"{BASE_URL}/generate-context-stream/",
    json={"chunks": chunks},
    stream=True
)

graph_data = []
client = sseclient.SSEClient(response)
for event in client.events():
    if event.data == '[DONE]':
        break
    graph_data.append(json.loads(event.data))

# Step 3: Save conversation
save_response = requests.post(
    f"{BASE_URL}/save_json/",
    json={
        "file_name": "AI_Research_Discussion",
        "chunks": chunks,
        "graph_data": graph_data,
        "conversation_id": "unique-uuid-here"
    }
)

print(f"Saved: {save_response.json()}")

# Step 4: Retrieve saved conversation
conversations = requests.get(f"{BASE_URL}/conversations/").json()
print(f"Total conversations: {len(conversations)}")

# Step 5: Get specific conversation
conv_id = conversations[0]["file_id"]
conversation = requests.get(f"{BASE_URL}/conversations/{conv_id}").json()
print(f"Retrieved conversation with {len(conversation['graph_data'])} nodes")
```

### WebSocket Audio Transcription

```javascript
// Browser example
const startTranscription = async () => {
  const ws = new WebSocket('ws://localhost:8080/ws/audio');
  let transcriptText = '';

  ws.onopen = () => {
    console.log('🎤 Transcription started');
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'connection_established') {
        console.log('✅ Connected to AssemblyAI');
        return;
      }

      if (data.text) {
        transcriptText += data.text + ' ';
        console.log('📝', data.text);

        if (data.is_final) {
          // Final transcription for this segment
          document.getElementById('transcript').innerText = transcriptText;
        }
      }
    } catch (e) {
      console.error('Parse error:', e);
    }
  };

  // Capture audio from microphone
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mediaRecorder = new MediaRecorder(stream, {
    mimeType: 'audio/webm'
  });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
      ws.send(event.data);
    }
  };

  mediaRecorder.start(250); // Send audio every 250ms

  // Stop after 30 seconds
  setTimeout(() => {
    mediaRecorder.stop();
    ws.close();
    console.log('🛑 Transcription stopped');
  }, 30000);
};

startTranscription();
```

---

## Interactive Documentation

For interactive API testing, visit:

**Swagger UI**: http://localhost:8080/docs
**ReDoc**: http://localhost:8080/redoc

These provide:
- Interactive request forms
- Schema documentation
- Try-it-out functionality
- Request/response examples

---

## Changelog

### Version 1.0 (Current)
- Initial API implementation
- All core endpoints functional
- WebSocket audio transcription
- GCS integration
- PostgreSQL database support

### Known Issues
- No rate limiting implemented
- Limited error details in some responses
- WebSocket reconnection not handled
- No request validation for some edge cases
- Missing API versioning

### Planned Enhancements
- Add API versioning (`/v1/`, `/v2/`)
- Implement rate limiting
- Add request/response validation middleware
- Enhanced error messages with troubleshooting hints
- Batch operations for multiple conversations
- Webhook support for long-running operations
- GraphQL endpoint option

---

**Last Updated:** 2025-11-10
**Maintainer:** Live Conversational Threads Team
**Support**: [GitHub Issues](https://github.com/anantham/live_conversational_threads/issues)
