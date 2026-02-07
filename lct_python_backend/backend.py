import anthropic
import os
import json
import logging
from logging.handlers import RotatingFileHandler
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Depends, BackgroundTasks, Query

# ============================================================================
# LOGGING CONFIGURATION - Persistent file-based logging
# ============================================================================
LOG_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "logs")
os.makedirs(LOG_DIR, exist_ok=True)

# Create logger
logger = logging.getLogger("lct_backend")
logger.setLevel(getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO))

# File handler - rotates at 10MB, keeps 5 backups
file_handler = RotatingFileHandler(
    os.path.join(LOG_DIR, "backend.log"),
    maxBytes=10*1024*1024,  # 10MB
    backupCount=5,
    encoding='utf-8'
)
file_handler.setLevel(logging.DEBUG)
file_handler.setFormatter(logging.Formatter(
    '%(asctime)s | %(levelname)-8s | %(name)s | %(funcName)s:%(lineno)d | %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
))

# Console handler for immediate visibility
console_handler = logging.StreamHandler()
console_handler.setLevel(logging.INFO)
console_handler.setFormatter(logging.Formatter(
    '%(asctime)s | %(levelname)-8s | %(message)s',
    datefmt='%H:%M:%S'
))

logger.addHandler(file_handler)
logger.addHandler(console_handler)

# Also capture uvicorn logs
logging.getLogger("uvicorn").addHandler(file_handler)
logging.getLogger("uvicorn.access").addHandler(file_handler)

logger.info("=" * 60)
logger.info("LCT Backend Starting - Logging initialized")
logger.info(f"Log file: {os.path.join(LOG_DIR, 'backend.log')}")
logger.info("=" * 60)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from pydantic import BaseModel, HttpUrl
import time
from typing import Dict, Generator, List, Any, Optional
import uuid
import random
import requests
from pathlib import Path
from google.cloud import storage
from datetime import datetime
# from db import db
# from db_helpers import get_all_conversations, insert_conversation_metadata, get_conversation_gcs_path
from lct_python_backend.db import db
from lct_python_backend.db_helpers import get_all_conversations, insert_conversation_metadata, get_conversation_gcs_path
from lct_python_backend.import_api import router as import_router
from lct_python_backend.bookmarks_api import router as bookmarks_router
from lct_python_backend.db_session import get_async_session
from lct_python_backend.services.transcript_processing import generate_lct_json
from lct_python_backend.stt_api import router as stt_router
from lct_python_backend.llm_api import router as llm_router
from lct_python_backend.middleware import configure_p0_security

# Audio retention config
AUDIO_RECORDINGS_DIR = os.getenv("AUDIO_RECORDINGS_DIR", "./lct_python_backend/recordings")
AUDIO_DOWNLOAD_TOKEN = os.getenv("AUDIO_DOWNLOAD_TOKEN", None)

os.makedirs(AUDIO_RECORDINGS_DIR, exist_ok=True)
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import func
from contextlib import asynccontextmanager
# from dotenv import load_dotenv

# load_dotenv() 


# Directory to save JSON files
# SAVE_DIRECTORY = "../saved_json"

# db
@asynccontextmanager
async def lifespan(app: FastAPI):
    print("[INFO] Connecting to database...")
    try:
        await db.connect()
        print("[INFO] Connected to database.")
    except Exception as e:
        print("[ERROR] Failed to connect to database during startup:")
        import traceback
        traceback.print_exc()
        raise e  # re-raise so the app still fails, but now you see why
    yield
    print("[INFO] Disconnecting from database...")
    await db.disconnect()
    
# fastapi app
lct_app = FastAPI(lifespan=lifespan)

# Configure CORS
lct_app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:5175",
        "http://localhost:5176",
        "http://localhost:5177",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
        "http://127.0.0.1:5175",
        "http://127.0.0.1:5176",
        "http://127.0.0.1:5177",
    ],  # Allow requests from Vite frontend (any port)
    allow_credentials=True,
    allow_methods=["*"],  # Allow all HTTP methods (GET, POST, etc.)
    allow_headers=["*"],  # Allow all headers
)

# P0 Security middleware (auth, rate limits, body size limits, SSRF gate)
configure_p0_security(lct_app)

# Include routers
lct_app.include_router(import_router)
lct_app.include_router(bookmarks_router)
lct_app.include_router(stt_router)
lct_app.include_router(llm_router)

# Serve JS/CSS/assets from Vite build folder
# lct_app.mount("/assets", StaticFiles(directory="frontend_dist/assets"), name="assets")



# perplexity api key
PERPLEXITY_API_KEY = os.getenv("PERPLEXITY_API_KEY")

#anthropic api key
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")

#google ai api key
GOOGLEAI_API_KEY = os.getenv("GOOGLEAI_API_KEY")

GCS_BUCKET_NAME = os.getenv("GCS_BUCKET_NAME")

GCS_FOLDER = os.getenv("GCS_FOLDER")


PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions"

# Pydantic Models
class TranscriptRequest(BaseModel):
    transcript: str

class ChunkedTranscript(BaseModel):
    chunks: Dict[str, str]  # Dictionary where keys are UUIDs and values are text chunks

class ChunkedRequest(BaseModel):
    chunks: Dict[str, str]  # Input to the streaming endpoint

class ProcessedChunk(BaseModel):
    chunk_id: str
    text: str

class SaveJsonRequest(BaseModel):
    file_name: str
    chunks: dict
    graph_data: List
    conversation_id: str

class SaveJsonResponse(BaseModel):
    message: str
    file_id: str  # UUID of the saved file
    file_name: str  # Original file name provided by the user
    
class generateFormalismRequest(BaseModel):
    chunks: dict
    graph_data: List
    user_pref: str

class generateFormalismResponse(BaseModel):
    formalism_data: List
    
class SaveJsonResponseExtended(BaseModel):
    file_id: str
    file_name: str
    message: str
    no_of_nodes: int
    created_at: Optional[str]
    
class ConversationResponse(BaseModel):
    graph_data: List[Any]
    chunk_dict: Dict[str, Any]
    
class Citation(BaseModel):
    title: str
    url: HttpUrl

class AnswerFormat(BaseModel):
    claim: str
    verdict: str  # "True", "False", "Unverified"
    explanation: str
    citations: List[Citation]  # max 2 preferred

class ClaimsResponse(BaseModel):
    claims: List[AnswerFormat]

class FactCheckRequest(BaseModel):
    claims: List[str]
    
class SaveFactCheckRequest(BaseModel):
    conversation_id: str
    node_name: str
    fact_check_data: List[AnswerFormat]
    
class GetFactCheckResponse(BaseModel):
    results: List[AnswerFormat]
    
# Function to chunk the text
def sliding_window_chunking(text: str, chunk_size: int = 10000, overlap: int = 2000) -> Dict[str, str]:
    assert chunk_size > overlap, "chunk_size must be greater than overlap!"

    words = text.split()
    chunks = {}
    start = 0

    while start < len(words):
        end = min(start + chunk_size, len(words))
        chunk_text = " ".join(words[start:end])
        chunks[str(uuid.uuid4())] = chunk_text
        start += chunk_size - overlap

    return chunks

def claude_llm_call(transcript: str, claude_prompt: str, start_text: str, temp: float = 0.6, retries: int = 5, backoff_base: float = 1.5):
    for attempt in range(retries):
        try:
            client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
            message = client.messages.create(
                model="claude-3-7-sonnet-20250219",
                max_tokens=20000,
                temperature=temp,
                system= claude_prompt,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": transcript
                                    }
                        ]
                    },
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "text",
                                "text": start_text
                            }
                        ]
                    }
                ]
            )
            return message.content[0].text
            
        except json.JSONDecodeError as e:
            print(f"[INFO]: Invalid JSON: {e}")
            return None

        except anthropic.AuthenticationError:
            print("[INFO]: Authentication failed. Check your API key.")
            return None

        except anthropic.RateLimitError:
            print("[INFO]: Rate limit exceeded. Retrying...")  # ✅ Retryable

        except anthropic.APIError as e:
            print(f"[INFO]: API error occurred: {e}")
            if "overloaded" not in str(e).lower():
                return None

        except Exception as e:
            print(f"[INFO]: Unexpected error: {e}")
            return None

        # Exponential backoff before next retry
        sleep_time = backoff_base ** attempt + random.uniform(0, 1)
        time.sleep(sleep_time)

    return None

# Function to generate JSON using Claude
def generate_lct_json_claude(transcript: str, temp: float = 0.6, retries: int = 5, backoff_base: float = 1.5):
    generate_lct_prompt = """You are an advanced AI model that structures conversations into strictly JSON-formatted nodes. Each conversational shift should be captured as a new node with defined relationships, with primary emphasis on capturing rich contextual connections that demonstrate thematic coherence, conceptual evolution, and cross-conversational idea building.
**Formatting Rules:**

**Instructions:**

**Handling New JSON Creation**
Extract Key Nodes: Identify all topic shifts in the conversation. Each topic shift forms a new "node", even if the topic was discussed earlier.

**Strictly Generate JSON Output:**
[
  {
    "node_name": "Title of the conversational thread",
    "type": "conversational_thread" or "bookmark",
    "predecessor": "Previous node name temporally",
    "successor": "Next node name temporally",
    "contextual_relation": {
      "Related Node 1": "Detailed explanation of how this node connects thematically, shows conceptual evolution, and builds upon ideas from the current discussion",
      "Related Node 2": " Another comprehensive explanation that weaves together thematic connections with how concepts have developed",
      "...": "Additional related nodes with their respective explanations can be included as needed"
    },
    "linked_nodes": [
      "List of all nodes this node is either drawing context from or providing context to"
    ],
    "chunk_id": null,  // This field will be **ignored** for now and will be added externally.
    "is_bookmark": true or false,
    ""is_contextual_progress": true or false,
    "summary": "Detailed description of what was discussed in this node."
  }
]
**Enhanced Contextual Relations Approach:**
-	In "contextual_relation", provide integrated explanations that naturally weave together:
-	How nodes connect thematically (shared concepts, related ideas)
-	How concepts have evolved or been refined since previous mentions
-	How ideas build upon each other across different conversation segments
-	 Don't capture direct shifts in conversations as contextual_relation unless there is a relevant contextual relation only then capture it.
Create cohesive narratives that explain the full relationship context rather than treating these as separate analytical dimensions.

**Define Structure:**
"predecessor" → The direct previous node temporally (empty for first node only).
"successor" → The direct next node temporally.
"contextual_relation" → Use this to explain how past nodes contribute to the current discussion contextually.
•	Keys = node names that contribute context.
•	Values = a detailed explanation of how the multiple referenced nodes influence the current discussion.

"linked_nodes" → A comprehensive list of all nodes this node is either drawing context from or providing context to, this information of context providing will come from "contextual_relation", consolidating references into a single field.
"chunk_id" → This field will be ignored for now, as it will be added externally by the code.

**Handling Updates to Existing JSON**
If an existing JSON structure is provided along with the transcript, modify it as follows and strictly return only the nodes generated for the current input transcript:

- **Continuing a topic**: If the conversation continues an existing discussion, update the "successor" field of the last relevant node.
-	**New topic**: If a conversation introduces a new topic, create a new node and properly link it.
-	**Revisiting a Bookmark**: If "LLM wish bookmark open [name]" appears, find the existing bookmark node and update its "contextual_relation" and "linked_nodes". Do NOT create a new bookmark when revisited—update the existing one instead.
-	**Contextual Relation Updates**: Maintain connections that demonstrate how past discussions influence current ones through integrated thematic, evolutionary, and developmental relationships.

**Chronology, Contextual Referencing and Bookmarking**
If a topic is revisited, create a new node while ensuring proper linking to previous mentions through rich contextual relations. Ensure mutual linking between nodes that provide context to each other through comprehensive relationship explanations.

**Each node must include both "predecessor" and "successor" fields to maintain chronological flow, maintaining the flow of the conversation irrespective of how related the topics are and strictly based on temporal relationship. Don't have predecessor empty if it is not the first node ever.**


**Conversational Threads nodes (type: "conversational_thread"):**
- Every topic shift must be captured as a new node.
- "contextual_relation" must provide integrated explanations of how previous discussions contribute to the current conversation through thematic connections, conceptual evolution, and idea building.
- "linked_nodes" must track all nodes this node is either drawing context from or providing context to in a single list.
- For nodes with type="conversational_thread", always set "is_bookmark": false.
 **Handling Revisited Topics**
 If a conversation returns to a previously discussed topic, create a new node and ensure "contextual_relation" provides comprehensive explanations of how past discussions relate to current context.

**Bookmark nodes (type: "bookmark") must:**
- A bookmark node must be created when "LLM wish bookmark create" appears, capturing the contextually relevant topic.
- Do not create bookmark node unless "LLM wish bookmark create" is mentioned.
- "contextual_relation" must reference nodes with integrated explanations of relationships, ensuring contextual continuity.
- The summary should clearly describe the reason for creating the bookmark and what it aims to track.
- If "LLM wish bookmark open" appears, do not create a new bookmark—update the existing one.
- For nodes with type="bookmark", always set "is_bookmark": true.



**Contextual Progress Capture ("is_contextual_progress": true):**
-	Only If "LLM wish capture contextual progress" appears, update the existing node (either "conversational_thread" or "bookmark") to include:
o	"is_contextual_progress": true
-	Contextual progress capture is used to capture a potential insight that might be present in that conversational node. 
-	It represents part of the conversation that could potentially be an insight that could be useful. These "potential insights" are the directions provided by humans that can later be taken by AI, which then uses this to generate formalisms.
-	Do not create a new node for contextual progress capture. Instead, apply the flag to the relevant existing node where the potential insight was introduced or referenced.
-**Contextual Relation & Linked Nodes Updates:**
- "contextual_relation" must provide comprehensive, integrated explanations that demonstrate the full scope of how nodes relate through thematic coherence, conceptual development, and cross-conversational idea building as unified relationship narratives.
- Don't capture direct shifts in conversations as contextual_relation unless there is a relevant contextual relation only then capture it.
- "linked_nodes" must include all references in a single list, capturing all nodes this node draws from or informs.
- The structure of "predecessor", "successor", and "contextual_relation" must ensure logical and chronological consistency between past and present discussions.

**Example Input**
**Existing JSON:**

**Transcript:**
Sam: Hey Taylor, I've got the mock-ups and timeline draft for the budgeting app.
Taylor: Nice! That covers the MVP milestones?
Sam: Yeah—dashboard, sync API, and notification system.
Taylor: Perfect. But we still haven't locked down pricing strategy.
Sam: Right. Ads, subscriptions, or freemium—still up in the air.
Taylor: We can survey beta users next week.
Sam: LLM wish bookmark create Startup Planning.
Taylor: Speaking of habits—have you stuck to your morning workout routine?
Sam: Mostly. I'm trying to anchor it to my coffee—habit stacking like we discussed.
Taylor: That's the best way. Pairing it with your podcast time might help too.
Sam: Good idea. I could listen to product strategy episodes while lifting.
Taylor: LLM wish capture contextual progress Fitness Habit Loop.
Sam: Quick tangent—remember when we talked about launching that writing tool?
Taylor: You mean the AI-assisted outlining app? Yeah. That convo got buried under budgeting app chaos.
Sam: Exactly. I still think it's viable. We had notes on use cases from early users.
Taylor: Let's revive it. Might even share infrastructure with the budgeting app backend.
Sam: LLM wish bookmark create Outlining Tool Revival.
Taylor: Okay, circling back—what's our go-to API for the budgeting app?
Sam: Plaid is expensive but reliable. Yodlee's cheaper, but older.
Taylor: And SaltEdge?
Sam: Less US coverage. I'm leaning Plaid.
Taylor: Cool, let's roll with it for beta. Add it to Startup Planning.
Sam: Done.
Taylor: So how do we test the pricing options?
Sam: I could build an A/B test into onboarding flows.
Taylor: Perfect. One with a free tier, one with premium-only.
Sam: And track conversion vs. churn. I'll prototype it.
Sam: LLM wish capture contextual progress Monetization Strategy.
Taylor: Oh, forgot to tell you—I pulled our old Notion doc on the outlining tool.
Sam: The one from last summer?
Taylor: Yep. User feedback section is gold. Matches what you said last week.
Sam: Let's cross-link that to our new app discussions too—some onboarding overlap.
Taylor: LLM wish bookmark open Outlining Tool Revival.
Sam: By the way, I watched that cyber-noir series finale. Intense!
Taylor: Don't spoil! I'm one episode behind.
Sam: Fine, but the twist connects to what we said about nonlinear story arcs in tools.
Taylor: Good point. Our outlining app should support multi-threaded plotting.
Sam: Anyway, quick check—what are today's key Startup Planning items?
Taylor: 1. Confirm Plaid. 2. Draft onboarding split test. 3. Prep beta survey questions.
Sam: Got it. I'll document and sync.
Taylor: Hey, back to the outlining app—we should prototype a plot tree view.
Sam: Like a drag-and-drop node system?
Taylor: Yes. With contextual linking between subplots. Nonlinear story design baked in.
Sam: Just like we talked about for knowledge graphs in the budgeting app.
Taylor: Exactly.
Sam: LLM wish bookmark open Startup Planning.
Taylor: I'll update with today's changes and next steps: implement API, finalize A/B logic, send beta invites.
Sam: I love how both projects are feeding into each other—makes the architecture stronger.
Taylor: Yeah, and it's helping us think modular.

Example JSON Output:
[
  {
    "node_name": "Budgeting App MVP Planning",
    "type": "conversational_thread",
    "predecessor": null,
    "successor": "Startup Planning Bookmark",
    "contextual_relation": {},
    "linked_nodes": [],
    "chunk_id": null,
    "is_bookmark": false,
    "is_contextual_progress": false,
    "summary": "Sam shares mock-ups and timeline for the budgeting app MVP including dashboard, sync API, and notification system. Taylor confirms coverage but notes pricing strategy (ads, subscriptions, or freemium) remains unresolved, planning beta user surveys for next week."
  },
  {
    "node_name": "Startup Planning Bookmark",
    "type": "bookmark",
    "predecessor": "Budgeting App MVP Planning",
    "successor": "Fitness and Product Strategy Integration",
    "contextual_relation": {
      "Budgeting App MVP Planning": "This bookmark captures the comprehensive startup planning elements including MVP milestones, unresolved pricing strategies, and the plan for beta user feedback gathering that will guide monetization decisions."
    },
    "linked_nodes": ["Budgeting App MVP Planning"],
    "chunk_id": null,
    "is_bookmark": true,
    "is_contextual_progress": false,
    "summary": "Sam creates a bookmark to track startup planning encompassing MVP development milestones and pricing strategy decisions for the budgeting app."
  },
  {
    "node_name": "Fitness and Product Strategy Integration",
    "type": "conversational_thread",
    "predecessor": "Startup Planning Bookmark",
    "successor": "Outlining Tool Revival",
    "contextual_relation": {},
    "linked_nodes": [],
    "chunk_id": null,
    "is_bookmark": false,
    "is_contextual_progress": true,
    "summary": "Taylor and Sam discuss morning workout habits using habit stacking (anchoring workouts to coffee time) and suggest combining with product strategy podcast listening. Taylor captures this as contextual progress for Fitness Habit Loop."
  },
  {
    "node_name": "Outlining Tool Revival",
    "type": "conversational_thread",
    "predecessor": "Fitness and Product Strategy Integration",
    "successor": "Outlining Tool Revival Bookmark",
    "contextual_relation": {
      "Budgeting App MVP Planning": "The AI-assisted outlining app project was deprioritized due to budgeting app development but remains viable with existing user feedback. Taylor suggests potential infrastructure sharing between both apps' backends, creating development synergies."
    },
    "linked_nodes": ["Budgeting App MVP Planning"],
    "chunk_id": null,
    "is_bookmark": false,
    "is_contextual_progress": false,
    "summary": "Sam recalls their previous AI-assisted outlining app project that got buried under budgeting app work. They still have valuable early user feedback and use cases, and Taylor suggests sharing infrastructure with the budgeting app backend."
  },
  {
    "node_name": "Outlining Tool Revival Bookmark",
    "type": "bookmark",
    "predecessor": "Outlining Tool Revival",
    "successor": "Technical Implementation Decisions",
    "contextual_relation": {
      "Outlining Tool Revival": "This bookmark captures the decision to revive the outlining app project, acknowledging its continued viability despite being overshadowed by budgeting app development, with potential for shared infrastructure benefits."
    },
    "linked_nodes": ["Outlining Tool Revival"],
    "chunk_id": null,
    "is_bookmark": true,
    "is_contextual_progress": false,
    "summary": "Sam creates a bookmark to track the revival of the AI-assisted outlining app project with its existing user feedback and potential infrastructure sharing opportunities."
  },
  {
    "node_name": "Technical Implementation Decisions",
    "type": "conversational_thread",
    "predecessor": "Outlining Tool Revival Bookmark",
    "successor": "Monetization Testing Strategy",
    "contextual_relation": {
      "Budgeting App MVP Planning": "The API selection (choosing Plaid over Yodlee and SaltEdge) directly implements the sync API component of the MVP. This technical decision balances cost versus reliability considerations critical to the startup's success.",
      "Startup Planning Bookmark": "The Plaid API decision represents a concrete technical commitment within the broader startup planning framework, affecting both development timeline and operational costs."
    },
    "linked_nodes": ["Budgeting App MVP Planning", "Startup Planning Bookmark"],
    "chunk_id": null,
    "is_bookmark": false,
    "is_contextual_progress": false,
    "summary": "Taylor and Sam evaluate API options for the budgeting app - comparing Plaid (expensive but reliable), Yodlee (cheaper but older), and SaltEdge (limited US coverage). They decide on Plaid for beta and add it to Startup Planning."
  },
  {
    "node_name": "Monetization Testing Strategy",
    "type": "conversational_thread",
    "predecessor": "Technical Implementation Decisions",
    "successor": "Documentation and Story Structure",
    "contextual_relation": {
      "Outlining Tool Revival": "Taylor's discovery of the old Notion documentation validates the outlining tool's potential with concrete user feedback. The onboarding overlap with the budgeting app suggests shared UX patterns that could accelerate both projects.",
      "Outlining Tool Revival Bookmark": "Opening this bookmark to add the documentation findings and cross-linking opportunities strengthens the revival case with historical context and identified synergies."
    },
    "linked_nodes": ["Outlining Tool Revival", "Outlining Tool Revival Bookmark"],
    "chunk_id": null,
    "is_bookmark": false,
    "is_contextual_progress": true,
    "summary": "Sam proposes building A/B tests into onboarding flows to test pricing options (free tier vs premium-only) while tracking conversion and churn metrics. Sam captures this as contextual progress for Monetization Strategy."
  },
  {
    "node_name": "Documentation and Story Structure",
    "type": "conversational_thread",
    "predecessor": "Monetization Testing Strategy",
    "successor": "Action Items and Feature Design",
    "contextual_relation": {
      "Outlining Tool Revival": "Taylor's discovery of the old Notion documentation validates the outlining tool's potential with concrete user feedback. The onboarding overlap with the budgeting app suggests shared UX patterns that could accelerate both projects.",
      "Outlining Tool Revival Bookmark": "Opening this bookmark to add the documentation findings and cross-linking opportunities strengthens the revival case with historical context and identified synergies."
    },
    "linked_nodes": ["Outlining Tool Revival", "Outlining Tool Revival Bookmark"],
    "chunk_id": null,
    "is_bookmark": false,
    "is_contextual_progress": false,
    "summary": "Taylor retrieves old Notion documentation on the outlining tool with valuable user feedback, noting onboarding overlap with the budgeting app. They open the Outlining Tool Revival bookmark. Discussion shifts to a cyber-noir series, connecting nonlinear story arcs to the need for multi-threaded plotting support in their tools."
  },
  {
    "node_name": "Action Items and Feature Design",
    "type": "conversational_thread",
    "predecessor": "Documentation and Story Structure",
    "successor": "Project Synergy Reflection",
    "contextual_relation": {
      "Technical Implementation Decisions": "The action items consolidate technical decisions - confirming Plaid API represents commitment to the chosen infrastructure despite higher costs.",
      "Monetization Testing Strategy": "Drafting the onboarding split test and preparing beta survey questions directly implements the A/B testing strategy for pricing model validation.",
      "Documentation and Story Structure": "The plot tree feature design with drag-and-drop nodes and contextual linking directly addresses the multi-threaded plotting needs identified through the story structure discussion.",
      "Budgeting App MVP Planning": "Sam's observation about knowledge graphs reveals deep architectural synergies - both apps can share node-based data structures and visualization components, validating the modular approach."
    },
    "linked_nodes": ["Technical Implementation Decisions", "Monetization Testing Strategy", "Documentation and Story Structure", "Budgeting App MVP Planning"],
    "chunk_id": null,
    "is_bookmark": false,
    "is_contextual_progress": false,
    "summary": "Sam reviews key Startup Planning items with Taylor: 1) Confirm Plaid, 2) Draft onboarding split test, 3) Prep beta survey questions. They then design a plot tree view feature for the outlining app with drag-and-drop nodes and contextual linking, connecting it to knowledge graph concepts in the budgeting app."
  },
  {
    "node_name": "Project Synergy Reflection",
    "type": "conversational_thread",
    "predecessor": "Action Items and Feature Design",
    "successor": null,
    "contextual_relation": {
      "Startup Planning Bookmark": "Sam reopens the bookmark to update it with concrete next steps: implement API, finalize A/B logic, and send beta invites, ensuring all planning elements remain actionable.",
      "Action Items and Feature Design": "The architectural synergies between projects validate the modular design approach, with shared components strengthening both applications.",
      "Outlining Tool Revival": "The mutual reinforcement between projects confirms the wisdom of reviving the outlining tool - it's not just independently viable but actively enhances the overall technical architecture."
    },
    "linked_nodes": ["Startup Planning Bookmark", "Action Items and Feature Design", "Outlining Tool Revival"],
    "chunk_id": null,
    "is_bookmark": false,
    "is_contextual_progress": false,
    "summary": "Sam opens Startup Planning bookmark while Taylor updates it with next steps. Sam appreciates how both projects feed into each other, strengthening the architecture, with Taylor noting this promotes modular thinking."
  }
]
"""
    for attempt in range(retries):
        try:
            client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
            message = client.messages.create(
                # model="claude-3-7-sonnet-20250219", # claude 3.7 sonnet
                model="claude-3-5-haiku-20241022", # claude 3.5 haiku
                # max_tokens=20000,
                max_tokens= 8192,
                temperature=temp,
                system= generate_lct_prompt,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": transcript
                                    }
                        ]
                    },
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "text",
                                "text": "[\n{"
                            }
                        ]
                    }
                ]
            )
            json_text = "[\n{" + message.content[0].text
            
            return json.loads(json_text)  # Parse JSON response
            

        except json.JSONDecodeError as e:
            print(f"[INFO]: Invalid JSON: {e}")
            return None

        except anthropic.AuthenticationError:
            print("[INFO]: Authentication failed. Check your API key.")
            return None

        except anthropic.RateLimitError:
            print("[INFO]: Rate limit exceeded. Retrying...")  # Retryable

        except anthropic.APIError as e:
            print(f"[INFO]: API error occurred: {e}")
            if "overloaded" not in str(e).lower():
                return None

        except Exception as e:
            print(f"[INFO]: Unexpected error: {e}")
            return None

def stream_generate_context_json(chunks: Dict[str, str]) -> Generator[str, None, None]:
    if not isinstance(chunks, dict):
        raise TypeError("The chunks must be a dictionary.")
    
    existing_json = []
    
    for chunk_id, chunk_text in chunks.items():
        mod_input = f'Existing JSON : \n {repr(existing_json)} \n\n Transcript Input: \n {chunk_text}'
        output_json = generate_lct_json(mod_input)
        # output_json = generate_lct_json_claude(mod_input)

        if output_json is None:
            yield json.dumps(existing_json)  # Send whatever we have so far
            continue

        for item in output_json:
            item["chunk_id"] = chunk_id  # Attach chunk ID

        existing_json.extend(output_json)
        yield json.dumps(existing_json)
        time.sleep(0.5)

# saving the JSON file
# def save_json(file_name: str, chunks: dict, graph_data: dict, conversation_id: str) -> dict:
#     """
#     Saves JSON data with a UUID filename but retains the original file name for display.

#     Parameters:
#     - file_name (str): The original file name entered by the user.
#     - chunks (dict): Transcript chunks.
#     - graph_data (dict): Graph representation.

#     Returns:
#     - dict: Contains 'file_id' (UUID) and the 'file_name'.
#     """
#     try:
#         os.makedirs(SAVE_DIRECTORY, exist_ok=True)
#         if conversation_id:
#             file_id = conversation_id
#         else:
#             file_id = str(uuid.uuid4())  # Generate a UUID
#         file_path = os.path.join(SAVE_DIRECTORY, f"{file_id}.json")

#         # Save JSON data including original file_name
#         data_to_save = {
#             "file_name": file_name,  # Preserve the original file name
#             "conversation_id": conversation_id,
#             "chunks": chunks,
#             "graph_data": graph_data
#         }


#         with open(file_path, "w", encoding="utf-8") as f:
#             json.dump(data_to_save, f, indent=4)

#         return {
#             "file_id": file_id,
#             "file_name": file_name,
#             "message": f"File '{file_name}' saved successfully!"
#         }

#     except Exception as e:
#         raise HTTPException(status_code=500, detail=f"Error saving JSON: {str(e)}")
    
# def save_json_to_gcs(file_name: str, chunks: dict, graph_data: list, conversation_id: str) -> dict:
#     try:
#         client = storage.Client()
#         bucket = client.bucket(GCS_BUCKET_NAME)

#         file_id = conversation_id or str(uuid.uuid4())
#         blob = bucket.blob(f"{GCS_FOLDER}/{file_id}.json")

#         data = {
#             "file_name": file_name,
#             "conversation_id": file_id,
#             "chunks": chunks,
#             "graph_data": graph_data
#         }

#         blob.upload_from_string(json.dumps(data, indent=4), content_type="application/json")

#         return {
#             "file_id": file_id,
#             "file_name": file_name,
#             "message": "Saved to GCS successfully"
#         }

#     except Exception as e:
#         raise HTTPException(status_code=500, detail=f"GCS Error: {str(e)}")
    
def save_json_to_gcs(
    file_name: str,
    chunks: dict,
    graph_data: list,
    conversation_id: str = None
) -> dict:
    try:
        client = storage.Client()
        bucket = client.bucket(GCS_BUCKET_NAME)

        file_id = conversation_id or str(uuid.uuid4())
        object_path = f"{GCS_FOLDER}/{file_id}.json"
        blob = bucket.blob(object_path)

        data = {
            "file_name": file_name,
            "conversation_id": file_id,
            "chunks": chunks,
            "graph_data": graph_data
        }

        blob.upload_from_string(json.dumps(data, indent=4), content_type="application/json")

        return {
            "file_id": file_id,
            "file_name": file_name,
            "message": "Saved to GCS successfully",
            "gcs_path": f"{object_path}"  # path for DB
        }

    except Exception as e:
        print(f"[FATAL] Failed to save JSON to GCS: {e}")
        raise
    
def load_conversation_from_gcs(gcs_path: str) -> dict:
    try:
        # Split GCS path into bucket and object path
        if "/" not in gcs_path:
            raise ValueError("Invalid GCS path. Must be in format 'bucket/path/to/file.json'")

        bucket_name = GCS_BUCKET_NAME
        object_path = gcs_path

        client = storage.Client()
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(object_path)

        if not blob.exists():
            raise HTTPException(status_code=404, detail="Conversation file not found in GCS.")
        data = json.loads(blob.download_as_string())
        graph_data = data.get("graph_data")
        chunk_dict = data.get("chunks")

        if graph_data is None or chunk_dict is None:
            raise HTTPException(status_code=422, detail="Invalid conversation file structure.")

        return {
            "graph_data": graph_data,
            "chunk_dict": chunk_dict,
        }

    except HTTPException:
        raise
    except Exception as e:
        print(f"[FATAL] GCS error loading path '{gcs_path}': {e}")
        raise HTTPException(status_code=500, detail=f"GCS error: {str(e)}")

def get_node_by_name(graph_data, node_name):
    for node in graph_data:
        if node.get("node_name") == node_name:
            return node
    return None


def convert_to_embedded(loopy_link, width=1000, height=600):

    iframe = f'<iframe width="800" height="600" frameborder="0" ' \
             f'src="{loopy_link}"></iframe>'
    try:
        return iframe
    except Exception as e:
        raise ValueError(f"Failed to convert to Loopy URL: {str(e)}")


def generate_formalism(chunks: dict, graph_data: dict, user_pref: str) -> List:
    
    formalism_list = []
    for node in graph_data[0]:
        contextual_node =''
        related_nodes = ''
        raw_text = ''
        loopy_url = None
        if 'is_contextual_progress' in node and node['is_contextual_progress']:
            contextual_node = str(node)
            for n in node['linked_nodes']:
                related_nodes += "\n" + str(get_node_by_name(graph_data[0], n))
            chunk_id = node['chunk_id']
            raw_text = chunks[chunk_id]
            
            formalism_input = f"conversation_data: \n contextual node : \n {contextual_node} \n related nodes : \n {related_nodes} \n user_research_background \n {user_pref} \n raw_text : \n {raw_text}"
            loopy_url = generate_individual_formalism(formalism_input=formalism_input)
            if loopy_url:
                # iframe_loopy_url = convert_to_embedded(loopy_url)
                formalism_list.append({
                    'formalism_node' : node['node_name'],
                    'formalism_graph_url' : loopy_url
                })
    return formalism_list

# all conversations
@lct_app.get("/conversations/", response_model=List[SaveJsonResponseExtended])
async def list_saved_conversations(db: AsyncSession = Depends(get_async_session)):
    try:
        from sqlalchemy import select
        from lct_python_backend.models import Conversation

        # Query conversations using SQLAlchemy ORM (exclude soft-deleted)
        result = await db.execute(
            select(Conversation)
            .where(Conversation.deleted_at.is_(None))  # Filter out soft-deleted conversations
            .order_by(Conversation.created_at.desc())
        )
        conversations_db = result.scalars().all()

        conversations = []
        for conv in conversations_db:
            conversations.append({
                "file_id": str(conv.id),
                "file_name": conv.conversation_name,
                "message": "Loaded from database",
                "no_of_nodes": conv.total_nodes or 0,
                "created_at": conv.created_at.isoformat() if conv.created_at else None
            })

        print(f"[INFO] Loaded {len(conversations)} conversations from DB")
        return conversations

    except Exception as e:
        print(f"[FATAL] Error fetching from DB: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Database access error: {str(e)}")
# def list_saved_conversations():
#     try:
#         print("[INFO] Initializing GCS client...")
#         client = storage.Client()
#         bucket = client.bucket(GCS_BUCKET_NAME)
#         print(f"[INFO] Accessing bucket: {GCS_BUCKET_NAME}")

#         blobs = bucket.list_blobs(prefix=GCS_FOLDER + "/")
#         saved_files = []
#         print(f"[INFO] Listing blobs with prefix '{GCS_FOLDER}/'")

#         for blob in blobs:
#             print(f"[DEBUG] Found blob: {blob.name}")
#             if not blob.name.endswith(".json"):
#                 print(f"[SKIP] Skipping non-JSON file: {blob.name}")
#                 continue

#             try:
#                 print(f"[INFO] Downloading blob: {blob.name}")
#                 content = blob.download_as_string()
#                 data = json.loads(content)

#                 conversation_id = data.get("conversation_id")
#                 file_name = data.get("file_name")
#                 graph_data = data.get("graph_data", [])

#                 no_of_nodes = len(graph_data[0]) if graph_data and isinstance(graph_data[0], list) else 0

#                 if not conversation_id or not file_name:
#                     raise ValueError("Missing required fields in JSON file.")
                
#                 created_at = blob.time_created.isoformat() if blob.time_created else None

#                 saved_files.append({
#                     "file_id": conversation_id,
#                     "file_name": file_name,
#                     "message": "Loaded from GCS",
#                     "no_of_nodes": no_of_nodes,
#                     "created_at": created_at
#                 })
#                 print(f"[SUCCESS] Loaded conversation: {conversation_id} - {file_name}")

#             except Exception as file_error:
#                 print(f"[ERROR] Error reading {blob.name}: {file_error}")
#                 continue

#         print(f"[INFO] Total conversations loaded: {len(saved_files)}")
#         return saved_files

#     except Exception as e:
#         print(f"[FATAL] Unexpected error in /conversations/: {e}")
#         raise HTTPException(status_code=500, detail=f"GCS access error: {str(e)}")
  
# get individual conversations
@lct_app.get("/conversations/{conversation_id}", response_model=ConversationResponse)
async def get_conversation(conversation_id: str, db: AsyncSession = Depends(get_async_session)):
    try:
        print(f"[INFO] Fetching conversation: {conversation_id}")

        from sqlalchemy import select
        from lct_python_backend.models import Conversation, Node, Utterance
        import uuid

        # Fetch conversation
        print(f"[INFO] Querying conversation from database...")
        result = await db.execute(
            select(Conversation).where(Conversation.id == uuid.UUID(conversation_id))
        )
        conversation = result.scalar_one_or_none()

        if not conversation:
            print(f"[ERROR] Conversation not found: {conversation_id}")
            raise HTTPException(status_code=404, detail="Conversation not found in database.")

        print(f"[INFO] Found conversation: {conversation.conversation_name}")

        # Fetch all nodes for this conversation
        print(f"[INFO] Querying nodes...")
        nodes_result = await db.execute(
            select(Node).where(Node.conversation_id == uuid.UUID(conversation_id))
        )
        nodes = list(nodes_result.scalars().all())
        print(f"[INFO] Found {len(nodes)} nodes")

        # Fetch all utterances for this conversation
        print(f"[INFO] Querying utterances...")
        utterances_result = await db.execute(
            select(Utterance)
            .where(Utterance.conversation_id == uuid.UUID(conversation_id))
            .order_by(Utterance.sequence_number)
        )
        utterances = list(utterances_result.scalars().all())
        print(f"[INFO] Found {len(utterances)} utterances")

        # Build graph_data from nodes
        graph_data = []

        if nodes:
            # Use actual analyzed nodes if they exist
            for node in nodes:
                node_data = {
                    "id": str(node.id),
                    "node_name": node.node_name,
                    "summary": node.summary,
                    "claims": [str(cid) for cid in (node.claim_ids or [])],
                    "key_points": node.key_points or [],
                    "predecessor": str(node.predecessor_id) if node.predecessor_id else None,
                    "successor": str(node.successor_id) if node.successor_id else None,
                    "contextual_relation": {},  # TODO: Need to fetch relationships from Relationship table
                    "linked_nodes": [],  # TODO: Need to fetch from Relationship table
                    "is_bookmark": node.is_bookmark,
                    "is_contextual_progress": node.is_contextual_progress,
                    "chunk_id": str(node.chunk_ids[0]) if node.chunk_ids else None,
                    "utterance_ids": [str(uid) for uid in (node.utterance_ids or [])]
                }
                graph_data.append(node_data)

        elif utterances:
            # Generate turn-based graph by grouping consecutive utterances by same speaker
            print(f"[INFO] No nodes found - generating turn-based graph from {len(utterances)} utterances")

            # Helper function to create intelligent node labels
            def create_node_label(speaker_name: str, text: str, max_length: int = 60) -> str:
                """Create a concise, meaningful label for a graph node."""
                # Clean up text
                text = text.strip()

                # Try to get first complete sentence
                sentence_endings = ['. ', '? ', '! ', '.\n', '?\n', '!\n']
                first_sentence_end = len(text)
                for ending in sentence_endings:
                    pos = text.find(ending)
                    if pos != -1 and pos < first_sentence_end:
                        first_sentence_end = pos + 1

                # Use first sentence if it's not too long
                if first_sentence_end < max_length:
                    summary = text[:first_sentence_end].strip()
                else:
                    # Otherwise, truncate at word boundary
                    if len(text) > max_length:
                        summary = text[:max_length].rsplit(' ', 1)[0] + "..."
                    else:
                        summary = text

                # Get speaker initial(s)
                speaker_parts = speaker_name.split()
                if len(speaker_parts) >= 2:
                    initials = ''.join([p[0].upper() for p in speaker_parts[:2]])
                else:
                    initials = speaker_name[:2].upper()

                return f"[{initials}] {summary}"

            if utterances:
                current_speaker = None
                current_turn = []
                turn_nodes = []
                turn_number = 0

                for idx, utt in enumerate(utterances):
                    # Check if this is a new speaker turn
                    if utt.speaker_id != current_speaker:
                        # Save previous turn if it exists
                        if current_turn:
                            turn_number += 1
                            combined_text = "\n".join([u.text for u in current_turn])
                            first_utt = current_turn[0]
                            last_utt = current_turn[-1]

                            turn_node = {
                                "id": f"turn_{turn_number}",
                                "node_name": create_node_label(current_speaker, combined_text),
                                "summary": combined_text[:150] + "..." if len(combined_text) > 150 else combined_text,
                                "full_text": combined_text,
                                "speaker_id": current_speaker,
                                "utterance_count": len(current_turn),
                                "sequence_number": first_utt.sequence_number,
                                "timestamp_start": first_utt.timestamp_start,
                                "timestamp_end": last_utt.timestamp_end,
                                "claims": [],
                                "key_points": [],
                                "predecessor": f"turn_{turn_number - 1}" if turn_number > 1 else None,
                                "successor": None,  # Will be set when next turn is created
                                "contextual_relation": {},
                                "linked_nodes": [],
                                "is_bookmark": False,
                                "is_contextual_progress": False,
                                "chunk_id": "default_chunk",
                                "utterance_ids": [str(u.id) for u in current_turn],
                                "is_utterance_node": True
                            }

                            # Set predecessor's successor
                            if turn_nodes:
                                turn_nodes[-1]["successor"] = turn_node["id"]

                            turn_nodes.append(turn_node)

                        # Start new turn
                        current_speaker = utt.speaker_id
                        current_turn = [utt]
                    else:
                        # Same speaker, add to current turn
                        current_turn.append(utt)

                # Add final turn
                if current_turn:
                    turn_number += 1
                    combined_text = "\n".join([u.text for u in current_turn])
                    first_utt = current_turn[0]
                    last_utt = current_turn[-1]

                    turn_node = {
                        "id": f"turn_{turn_number}",
                        "node_name": create_node_label(current_speaker, combined_text),
                        "summary": combined_text[:150] + "..." if len(combined_text) > 150 else combined_text,
                        "full_text": combined_text,
                        "speaker_id": current_speaker,
                        "utterance_count": len(current_turn),
                        "sequence_number": first_utt.sequence_number,
                        "timestamp_start": first_utt.timestamp_start,
                        "timestamp_end": last_utt.timestamp_end,
                        "claims": [],
                        "key_points": [],
                        "predecessor": f"turn_{turn_number - 1}" if turn_number > 1 else None,
                        "successor": None,
                        "contextual_relation": {},
                        "linked_nodes": [],
                        "is_bookmark": False,
                        "is_contextual_progress": False,
                        "chunk_id": "default_chunk",
                        "utterance_ids": [str(u.id) for u in current_turn],
                        "is_utterance_node": True
                    }

                    if turn_nodes:
                        turn_nodes[-1]["successor"] = turn_node["id"]

                    turn_nodes.append(turn_node)

                graph_data = turn_nodes
                print(f"[INFO] Generated {len(graph_data)} speaker turns from {len(utterances)} utterances")

        # Build chunk_dict from utterances
        # Group utterances by chunk_id if available, otherwise create a default chunk
        chunk_dict = {}
        if utterances:
            # For now, create a single chunk with all utterances
            default_chunk_id = "default_chunk"
            chunk_text = "\n".join([f"{utt.speaker_id}: {utt.text}" for utt in utterances])
            chunk_dict[default_chunk_id] = chunk_text
            print(f"[INFO] Created chunk with {len(utterances)} utterances")

        print(f"[INFO] Successfully built response with {len(graph_data)} nodes and {len(chunk_dict)} chunks")

        # Wrap graph_data in an array to match expected nested structure
        # Frontend expects [[node1, node2], [node3, node4]] (array of chunks)
        # We send all nodes as a single chunk: [[node1, node2, node3]]
        if graph_data:
            graph_data_nested = [graph_data]  # Wrap in array
        else:
            graph_data_nested = []  # Empty array for no nodes

        print(f"[INFO] Returning nested graph_data structure with {len(graph_data_nested)} chunks")

        return ConversationResponse(
            graph_data=graph_data_nested,
            chunk_dict=chunk_dict
        )

    except HTTPException:
        raise
    except Exception as e:
        print(f"[FATAL] Error loading conversation '{conversation_id}': {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Server error: {str(e)}") 
# @lct_app.get("/conversations/{conversation_id}", response_model=ConversationResponse)
# def get_conversation(conversation_id: str):
#     try:
#         client = storage.Client()
#         bucket = client.bucket(GCS_BUCKET_NAME)
#         blob_path = f"{GCS_FOLDER}/{conversation_id}.json"
#         print(f"bucket: {bucket}, blob: {blob_path}")
#         blob = bucket.blob(blob_path)

#         if not blob.exists():
#             raise HTTPException(status_code=404, detail="Conversation not found in GCS.")

#         data = json.loads(blob.download_as_string())

#         graph_data = data.get("graph_data")
#         chunk_dict = data.get("chunks")

#         if graph_data is None or chunk_dict is None:
#             raise HTTPException(status_code=422, detail="Invalid conversation file structure.")

#         return {
#             "graph_data": graph_data,
#             "chunk_dict": chunk_dict,
#         }

#     except HTTPException:
#         raise

#     except Exception as e:
#         print(f"[FATAL] Error fetching {conversation_id} from GCS: {e}")
#         raise HTTPException(status_code=500, detail=f"GCS error: {str(e)}")


# Delete conversation endpoint
@lct_app.delete("/conversations/{conversation_id}")
async def delete_conversation(
    conversation_id: str,
    hard_delete: bool = False,
    db: AsyncSession = Depends(get_async_session)
):
    """
    Delete a conversation (soft or hard delete).

    Args:
        conversation_id: UUID of conversation to delete
        hard_delete: If True, permanently delete from DB and GCS; if False, soft delete (set deleted_at)

    Returns:
        Success message with conversation_id
    """
    try:
        from sqlalchemy import select, update
        from lct_python_backend.models import Conversation
        import uuid as uuid_lib

        # Fetch conversation
        result = await db.execute(
            select(Conversation).where(Conversation.id == uuid_lib.UUID(conversation_id))
        )
        conversation = result.scalar_one_or_none()

        if not conversation:
            raise HTTPException(status_code=404, detail="Conversation not found")

        if hard_delete:
            # Delete from GCS if path exists
            if conversation.gcs_path:
                try:
                    client = storage.Client()
                    bucket = client.bucket(GCS_BUCKET_NAME)
                    blob = bucket.blob(conversation.gcs_path)
                    if blob.exists():
                        blob.delete()
                        print(f"[INFO] Deleted GCS file: {conversation.gcs_path}")
                    else:
                        print(f"[WARNING] GCS file not found: {conversation.gcs_path}")
                except Exception as gcs_error:
                    print(f"[WARNING] Failed to delete GCS file: {gcs_error}")

            # Hard delete from DB (CASCADE will handle related tables)
            await db.delete(conversation)
            await db.commit()
            message = "Conversation permanently deleted"
            print(f"[INFO] Hard deleted conversation: {conversation_id}")
        else:
            # Soft delete
            await db.execute(
                update(Conversation)
                .where(Conversation.id == uuid_lib.UUID(conversation_id))
                .values(deleted_at=func.now())
            )
            await db.commit()
            message = "Conversation deleted"
            print(f"[INFO] Soft deleted conversation: {conversation_id}")

        return {"message": message, "conversation_id": conversation_id}

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Failed to delete conversation: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Deletion failed: {str(e)}")

# Endpoint to get transcript chunks
@lct_app.post("/get_chunks/", response_model=ChunkedTranscript)
async def get_chunks(request: TranscriptRequest):
    try:
        transcript = request.transcript

        if not transcript:
            raise HTTPException(status_code=400, detail="Transcript must be a non-empty string.")

        chunks = sliding_window_chunking(transcript)

        if not chunks:
            raise HTTPException(status_code=500, detail="Chunking failed. No chunks were generated.")

        return ChunkedTranscript(chunks=chunks)

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {str(e)}")

# Streaming Endpoint for JSON generation
@lct_app.post("/generate-context-stream/")
async def generate_context_stream(request: ChunkedRequest):
    try:
        chunks = request.chunks

        if not chunks or not isinstance(chunks, dict):
            raise HTTPException(status_code=400, detail="Chunks must be a non-empty dictionary.")

        return StreamingResponse(stream_generate_context_json(chunks), media_type="application/json")

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {str(e)}")
    
@lct_app.post("/save_json/", response_model=SaveJsonResponse)
async def save_json_call(request: SaveJsonRequest):
    """
    FastAPI route to save JSON data and insert metadata into the DB.
    """
    try:
        # Validate input
        if not request.file_name.strip():
            raise HTTPException(status_code=400, detail="File name cannot be empty.")

        if not isinstance(request.chunks, dict) or not isinstance(request.graph_data, list):
            raise HTTPException(status_code=400, detail="Chunks must be a valid dictionary and Graph Data must be a valid list.")

        try:
            result = save_json_to_gcs(
                request.file_name,
                request.chunks,
                request.graph_data,
                request.conversation_id
            )
        except Exception as file_error:
            raise HTTPException(status_code=500, detail=f"File saving error: {str(file_error)}")

        # Insert metadata into DB
        number_of_nodes = len(request.graph_data[0]) if request.graph_data and isinstance(request.graph_data[0], list) else 0
        print("graph data check: ", request.graph_data)
        print("number of nodes: ", len(request.graph_data[0]) if request.graph_data and isinstance(request.graph_data[0], list) else 0)
        metadata = {
            "id": result["file_id"],
            "conversation_name": result["file_name"],  # Database column is conversation_name
            "total_nodes": number_of_nodes,
            "gcs_path": result["gcs_path"],
            "created_at": datetime.utcnow()
        }
        print(f"[DEBUG] Inserting metadata: conversation_name={result['file_name']}, total_nodes={number_of_nodes}")

        await insert_conversation_metadata(metadata)

        return result

    except HTTPException as http_err:
        raise http_err

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Unexpected error: {str(e)}")
# @lct_app.post("/save_json/", response_model=SaveJsonResponse)
# async def save_json_call(request: SaveJsonRequest):
#     """
#     FastAPI route to save JSON data using an external function.
#     """
#     try:
#         # Validate input data
#         if not request.file_name.strip():
#             raise HTTPException(status_code=400, detail="File name cannot be empty.")

#         if not isinstance(request.chunks, dict) or not isinstance(request.graph_data, List):
#             raise HTTPException(status_code=400, detail="Chunks must be a valid dictionary and Graph Data must be a valid list.")
#         try:
#             # result = save_json(request.file_name, request.chunks, request.graph_data, request.conversation_id) # save json function
#             result = save_json_to_gcs(request.file_name, request.chunks, request.graph_data, request.conversation_id) # save json function
#         except Exception as file_error:
#             raise HTTPException(status_code=500, detail=f"File saving error: {str(file_error)}")

#         return result

#     except HTTPException as http_err:
#         raise http_err  # Re-raise HTTP exceptions as they are

#     except Exception as e:
#         raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {str(e)}")
    
@lct_app.post("/generate_formalism/", response_model=generateFormalismResponse)
async def generate_formalism_call(request: generateFormalismRequest):
    try:
        # Validate input data
        if not isinstance(request.chunks, dict) or not isinstance(request.graph_data, List):
            raise HTTPException(status_code=400, detail="Chunks must be a valid dictionary and Graph Data must be a valid list.")
        try:
            result = generate_formalism(request.chunks, request.graph_data, request.user_pref) # save json function
        except Exception as formalism_error:
            print(f"[INFO]: Formalism Generation error: {formalism_error}")
            raise HTTPException(status_code=500, detail=f"Formalism Generation error: {str(formalism_error)}")

        return {"formalism_data": result}

    except HTTPException as http_err:
        raise http_err  # Re-raise HTTP exceptions as they are

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {str(e)}")
    
# Serve index.html at root
# @lct_app.get("/")
# def read_root():
#     return FileResponse("frontend_dist/index.html")

# # Serve favicon or other top-level static files
# @lct_app.get("/favicon.ico")
# def favicon():
#     file_path = "frontend_dist/favicon.ico"
#     if os.path.exists(file_path):
#         return FileResponse(file_path)
#     return {}

# # Catch-all for SPA routes (NOT static files)
# @lct_app.get("/{full_path:path}")
# async def spa_router(full_path: str):
#     file_path = f"frontend_dist/{full_path}"
#     if os.path.exists(file_path):
#         return FileResponse(file_path)
#     return FileResponse("frontend_dist/index.html")

@lct_app.post("/fact_check_claims/", response_model=ClaimsResponse)
async def fact_check_claims_call(request: FactCheckRequest):
    try:
        if not request.claims:
            raise HTTPException(status_code=400, detail="No claims provided.")

        result = generate_fact_check_json_perplexity(request.claims)
        if result is None:
            raise HTTPException(status_code=500, detail="Fact-checking service failed.")
        
        return result

    except HTTPException as http_err:
        raise http_err
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {str(e)}")

# Download recorded audio (token gated)
@lct_app.get("/api/conversations/{conversation_id}/audio")
async def download_audio(conversation_id: str, token: Optional[str] = Query(None)):
    if AUDIO_DOWNLOAD_TOKEN and token != AUDIO_DOWNLOAD_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing token")

    wav_path = Path(AUDIO_RECORDINGS_DIR) / f"{conversation_id}.wav"
    flac_path = Path(AUDIO_RECORDINGS_DIR) / f"{conversation_id}.flac"

    if wav_path.exists():
        return FileResponse(wav_path, media_type="audio/wav", filename=wav_path.name)
    if flac_path.exists():
        return FileResponse(flac_path, media_type="audio/flac", filename=flac_path.name)

    raise HTTPException(status_code=404, detail="Recording not found")

# @lct_app.post("/save_fact_check/")
# async def save_fact_check_call(request: SaveFactCheckRequest):
#     try:
#         # Serialize the fact_check_data to a JSON string
#         results_json = json.dumps([r.dict() for r in request.fact_check_data])
        
#         await save_fact_check_results(request.conversation_id, request.node_name, results_json)
        
#         return {"message": "Fact-check results saved successfully."}
    
#     except Exception as e:
#         print(f"[FATAL] Error saving fact-check data: {e}")
#         raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

# @lct_app.get("/get_fact_check/{conversation_id}/{node_name}", response_model=GetFactCheckResponse)
# async def get_fact_check_call(conversation_id: str, node_name: str):
#     try:
#         results_data = await get_fact_check_results(conversation_id, node_name)

#         if results_data is not None:
#             return {"results": results_data}

#         # If no record is found, return an empty list of results
#         return {"results": []}

#     except Exception as e:
#         print(f"[FATAL] Error fetching fact-check data: {e}")


# Obsidian Canvas Export/Import Models
class CanvasNode(BaseModel):
    id: str
    type: str  # "text", "file", "link", "group"
    x: int
    y: int
    width: int
    height: int
    color: Optional[str] = None
    text: Optional[str] = None  # For text nodes
    file: Optional[str] = None  # For file nodes
    url: Optional[str] = None  # For link nodes
    label: Optional[str] = None  # For group nodes

class CanvasEdge(BaseModel):
    id: str
    fromNode: str
    toNode: str
    fromSide: Optional[str] = None
    toSide: Optional[str] = None
    fromEnd: Optional[str] = "none"
    toEnd: Optional[str] = "arrow"
    color: Optional[str] = None
    label: Optional[str] = None

class ObsidianCanvas(BaseModel):
    nodes: List[CanvasNode]
    edges: List[CanvasEdge]

class CanvasExportRequest(BaseModel):
    conversation_id: str
    file_name: Optional[str] = None
    include_chunks: bool = False  # Whether to include chunk content as separate nodes

class CanvasImportRequest(BaseModel):
    canvas_data: ObsidianCanvas
    file_name: str
    preserve_positions: bool = True


def convert_conversation_to_canvas(
    graph_data: List,
    chunk_dict: Dict[str, str],
    file_name: str,
    include_chunks: bool = False,
    edge_records: Optional[List[Dict[str, str]]] = None,
) -> ObsidianCanvas:
    """
    Convert conversation tree format to Obsidian Canvas format.

    Args:
        graph_data: List containing conversation nodes (format: [[nodes]])
        chunk_dict: Dictionary mapping chunk IDs to text content
        file_name: Name of the conversation (used for title node)
        include_chunks: Whether to include chunk content as separate nodes
        edge_records: Optional list of precomputed edges to inject (from relationships)

    Returns:
        ObsidianCanvas object with nodes and edges
    """
    nodes: List[CanvasNode] = []
    edges: List[CanvasEdge] = []

    # Extract nodes from graph_data (format is [[nodes]])
    conversation_nodes = graph_data[0] if graph_data and isinstance(graph_data[0], list) else []

    if not conversation_nodes:
        raise ValueError("No nodes found in conversation data")

    # Build node position map using hierarchical layout
    node_positions = {}
    node_map = {node["node_name"]: node for node in conversation_nodes}

    # Find root nodes (nodes without predecessors)
    root_nodes = [node for node in conversation_nodes if not node.get("predecessor")]

    # Simple hierarchical layout algorithm
    NODE_WIDTH = 350
    NODE_HEIGHT = 200
    # Spacing: horizontal = 2x node width, vertical = 3x node height
    HORIZONTAL_SPACING = 2 * NODE_WIDTH  # 700px = 350px gap between nodes
    VERTICAL_SPACING = 3 * NODE_HEIGHT   # 600px = 400px gap between nodes

    def calculate_positions(current_node, x, y, visited):
        """Recursively calculate positions for nodes"""
        node_name = current_node["node_name"]

        if node_name in visited:
            return y

        visited.add(node_name)
        node_positions[node_name] = {"x": x, "y": y}

        # Find successor
        successor_name = current_node.get("successor")
        if successor_name and successor_name in node_map:
            successor = node_map[successor_name]
            y = calculate_positions(successor, x + HORIZONTAL_SPACING, y, visited)
        else:
            y += VERTICAL_SPACING

        return y

    # Calculate positions starting from root nodes
    visited = set()
    current_y = 100
    for root in root_nodes:
        current_y = calculate_positions(root, 100, current_y, visited)

    # Handle orphan nodes (nodes not connected to any root)
    orphan_x = 100
    orphan_y = current_y + VERTICAL_SPACING
    for node in conversation_nodes:
        if node["node_name"] not in visited:
            node_positions[node["node_name"]] = {"x": orphan_x, "y": orphan_y}
            orphan_x += HORIZONTAL_SPACING
            if orphan_x > 2000:  # Wrap to next row
                orphan_x = 100
                orphan_y += VERTICAL_SPACING

    # Create Canvas nodes
    for node in conversation_nodes:
        node_name = node["node_name"]
        position = node_positions.get(node_name, {"x": 100, "y": 100})

        # Determine node color based on flags
        color = None
        if node.get("is_bookmark"):
            color = "5"  # Cyan/Blue for bookmarks
        elif node.get("is_contextual_progress"):
            color = "4"  # Green for contextual progress

        # Build node text content with markdown
        text_content = f"# {node_name}\n\n"
        text_content += f"{node.get('summary', '')}\n\n"

        if node.get("claims"):
            text_content += "## Claims\n"
            for claim in node["claims"]:
                text_content += f"- {claim}\n"
            text_content += "\n"

        if node.get("chunk_id") and not include_chunks:
            text_content += f"*Chunk ID: {node['chunk_id']}*\n"

        # Calculate height based on text length (rough estimate)
        estimated_height = max(NODE_HEIGHT, min(600, len(text_content) // 3))

        canvas_node = CanvasNode(
            id=node_name.replace(" ", "_"),
            type="text",
            x=position["x"],
            y=position["y"],
            width=NODE_WIDTH,
            height=estimated_height,
            color=color,
            text=text_content
        )
        nodes.append(canvas_node)

    # Create edges: first from supplied edge_records (relationships), then fallback temporal/contextual
    edge_counter = 0
    created_edges = set()

    def add_edge(from_id: str, to_id: str, label: str, color: str, from_side=None, to_side=None, from_end="none", to_end="arrow"):
        nonlocal edge_counter
        edge_key = f"{from_id}->{to_id}:{label}:{color}"
        if edge_key in created_edges:
            return
        edges.append(
            CanvasEdge(
                id=f"edge_{edge_counter}",
                fromNode=from_id,
                toNode=to_id,
                fromSide=from_side,
                toSide=to_side,
                fromEnd=from_end,
                toEnd=to_end,
                color=color,
                label=label,
            )
        )
        created_edges.add(edge_key)
        edge_counter += 1

    # Inject edges provided via edge_records (relationships)
    if edge_records:
        for rec in edge_records:
            source = rec.get("fromNode") or rec.get("from") or rec.get("source")
            target = rec.get("toNode") or rec.get("to") or rec.get("target")
            label = rec.get("label") or rec.get("type") or "related"
            color = rec.get("color") or "3"
            if source and target:
                add_edge(source, target, label, color, from_end="none", to_end="arrow")

    # Fallback: temporal/contextual relationships derived from graph_data
    for node in conversation_nodes:
        node_id = node["node_name"].replace(" ", "_")

        # Temporal edge (successor)
        if node.get("successor"):
            successor_id = node["successor"].replace(" ", "_")
            add_edge(node_id, successor_id, "next", "1", from_side="right", to_side="left", to_end="arrow")

        # Contextual relationships
        if node.get("contextual_relation"):
            for related_node_name, explanation in node["contextual_relation"].items():
                related_id = related_node_name.replace(" ", "_")
                label = explanation[:50] + "..." if len(explanation) > 50 else explanation
                add_edge(node_id, related_id, label or "related", "3", from_end="none", to_end="none")

    # Add chunk nodes if requested
    if include_chunks:
        chunk_y = max([pos["y"] for pos in node_positions.values()], default=0) + VERTICAL_SPACING * 2
        chunk_x = 100

        for chunk_id, chunk_text in chunk_dict.items():
            canvas_node = CanvasNode(
                id=f"chunk_{chunk_id}",
                type="text",
                x=chunk_x,
                y=chunk_y,
                width=NODE_WIDTH,
                height=300,
                color="6",  # Purple for chunks
                text=f"# Chunk: {chunk_id}\n\n{chunk_text[:500]}..."  # Truncate long chunks
            )
            nodes.append(canvas_node)

            # Link chunk to related conversation nodes
            for node in conversation_nodes:
                if node.get("chunk_id") == chunk_id:
                    node_id = node["node_name"].replace(" ", "_")
                    edge = CanvasEdge(
                        id=f"edge_{edge_counter}",
                        fromNode=node_id,
                        toNode=f"chunk_{chunk_id}",
                        fromEnd="none",
                        toEnd="none",
                        color="2",  # Orange for chunk links
                        label="references"
                    )
                    edges.append(edge)
                    edge_counter += 1

            chunk_x += HORIZONTAL_SPACING
            if chunk_x > 2000:
                chunk_x = 100
                chunk_y += VERTICAL_SPACING

    return ObsidianCanvas(nodes=nodes, edges=edges)


@lct_app.post("/export/obsidian-canvas/{conversation_id}")
async def export_to_obsidian_canvas(
    conversation_id: str,
    include_chunks: bool = False,
    db: AsyncSession = Depends(get_async_session)
):
    """
    Export a conversation to Obsidian Canvas format.

    Args:
        conversation_id: The ID of the conversation to export
        include_chunks: Whether to include chunk content as separate nodes

    Returns:
        JSON response with Canvas format that can be saved as .canvas file
    """
    try:
        print(f"[INFO] Exporting conversation {conversation_id} to Obsidian Canvas (include_chunks={include_chunks})")

        from sqlalchemy import select
        from lct_python_backend.models import Conversation, Node, Utterance, Relationship
        import uuid

        # Fetch conversation from PostgreSQL
        result = await db.execute(
            select(Conversation).where(Conversation.id == uuid.UUID(conversation_id))
        )
        conversation = result.scalar_one_or_none()

        if not conversation:
            print(f"[ERROR] Conversation not found: {conversation_id}")
            raise HTTPException(status_code=404, detail="Conversation not found")

        print(f"[INFO] Found conversation: {conversation.conversation_name}")

        # Fetch all nodes for this conversation
        nodes_result = await db.execute(
            select(Node).where(Node.conversation_id == uuid.UUID(conversation_id))
        )
        nodes = list(nodes_result.scalars().all())
        print(f"[INFO] Found {len(nodes)} nodes")

        # Fetch all relationships for this conversation
        relationships_result = await db.execute(
            select(Relationship).where(Relationship.conversation_id == uuid.UUID(conversation_id))
        )
        relationships = list(relationships_result.scalars().all())
        print(f"[INFO] Found {len(relationships)} relationships")

        # Fetch all utterances for this conversation
        utterances_result = await db.execute(
            select(Utterance)
            .where(Utterance.conversation_id == uuid.UUID(conversation_id))
            .order_by(Utterance.sequence_number)
        )
        utterances = list(utterances_result.scalars().all())
        print(f"[INFO] Found {len(utterances)} utterances")

        # Build graph_data from nodes
        graph_data = []
        chunk_dict = {}

        # Create mapping from node ID to node name
        id_to_name = {node.id: node.node_name for node in nodes}

        # Build relationship data structures (and collect edges for Canvas)
        successor_map = {}           # node_id -> successor_node_name
        contextual_map = {}          # node_id -> {related_node_name: relationship_type}
        canvas_edges = []            # edges to emit in canvas

        for rel in relationships:
            from_name = id_to_name.get(rel.from_node_id)
            to_name = id_to_name.get(rel.to_node_id)

            if not from_name or not to_name:
                continue

            rel_type = rel.relationship_type or "related"
            rel_type_lower = rel_type.lower()

            # Check relationship type to determine if it's temporal (successor) or contextual
            if rel_type_lower in ['leads_to', 'next', 'follows']:
                successor_map[rel.from_node_id] = to_name
            else:
                if rel.from_node_id not in contextual_map:
                    contextual_map[rel.from_node_id] = {}
                contextual_map[rel.from_node_id][to_name] = rel_type

            # Map to Canvas edge color: 1=red (temporal here unused), 2=orange (chunks), 3=neutral, 4=green
            if rel_type_lower in ["supports", "informs", "builds_on", "enables", "affirms"]:
                color = "4"  # green
            elif rel_type_lower in ["contradicts", "opposes", "refutes", "challenges", "conflicts", "disagrees"]:
                color = "1"  # red
            elif rel_type_lower in ["leads_to", "next", "follows"]:
                color = "3"  # neutral for temporal
            else:
                color = "3"  # neutral/default

            canvas_edges.append({
                "id": f"edge_{rel.id}",
                "fromNode": str(rel.from_node_id),
                "toNode": str(rel.to_node_id),
                "label": rel_type,
                "color": color,
            })

        for node in nodes:
            node_data = {
                "id": str(node.id),
                "node_name": node.node_name,
                "summary": node.summary,
                "claims": [str(cid) for cid in (node.claim_ids or [])],
                "key_points": node.key_points or [],
                "predecessor": None,  # Will be computed from successor relationships
                "successor": successor_map.get(node.id),
                "contextual_relation": contextual_map.get(node.id, {}),
                "linked_nodes": [],
                "is_bookmark": node.is_bookmark,
                "is_contextual_progress": node.is_contextual_progress,
                "chunk_id": str(node.chunk_ids[0]) if node.chunk_ids else None,
                "utterance_ids": [str(uid) for uid in (node.utterance_ids or [])]
            }
            graph_data.append(node_data)

            # Build chunk_dict if including chunks
            if include_chunks and node.chunk_ids:
                for chunk_id in node.chunk_ids:
                    chunk_id_str = str(chunk_id)
                    if chunk_id_str not in chunk_dict:
                        # Get utterances for this chunk
                        chunk_utterances = [
                            utt for utt in utterances
                            if utt.chunk_id and str(utt.chunk_id) == chunk_id_str
                        ]
                        # Combine utterance texts
                        chunk_text = "\n".join([utt.text for utt in chunk_utterances])
                        chunk_dict[chunk_id_str] = chunk_text

        print(f"[INFO] Built graph_data with {len(graph_data)} nodes and {len(chunk_dict)} chunks")

        # Use conversation name as file name
        file_name = conversation.conversation_name or "Untitled Conversation"

        # Wrap graph_data in a list for the expected format [[nodes]]
        wrapped_graph_data = [graph_data]

        # Convert to Canvas format (with edges)
        canvas = convert_conversation_to_canvas(
            wrapped_graph_data,
            chunk_dict,
            file_name,
            include_chunks,
            edge_records=canvas_edges
        )

        print(f"[INFO] ✅ Successfully exported conversation to Canvas")
        # Return as JSON (user can save as .canvas file)
        return canvas.model_dump()

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Failed to export conversation to Canvas: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")


def convert_canvas_to_conversation(canvas: ObsidianCanvas, preserve_positions: bool = True) -> tuple:
    """
    Convert Obsidian Canvas format to conversation tree format.

    Args:
        canvas: ObsidianCanvas object with nodes and edges
        preserve_positions: Whether to preserve node positions (stored in metadata)

    Returns:
        Tuple of (graph_data, chunk_dict)
    """
    conversation_nodes = []
    chunk_dict = {}

    # Build maps for edges
    temporal_edges = {}  # node_id -> successor_id (for predecessor/successor)
    contextual_edges = {}  # node_id -> [(target_id, label)]

    for edge in canvas.edges:
        # Temporal edges have "next" label or are red (color "1")
        if edge.label == "next" or edge.color == "1":
            temporal_edges[edge.fromNode] = edge.toNode
        # Chunk reference edges
        elif edge.label == "references" or edge.color == "2":
            continue  # Skip chunk reference edges for now
        # Contextual edges
        else:
            if edge.fromNode not in contextual_edges:
                contextual_edges[edge.fromNode] = []
            contextual_edges[edge.fromNode].append((edge.toNode, edge.label or "Related"))

    # Process nodes
    for node in canvas.nodes:
        # Skip non-text nodes and chunk nodes
        if node.type != "text" or node.id.startswith("chunk_"):
            if node.id.startswith("chunk_"):
                # Extract chunk content
                chunk_id = node.id.replace("chunk_", "")
                chunk_dict[chunk_id] = node.text or ""
            continue

        # Extract node name from ID (reverse the replacement)
        node_name = node.id.replace("_", " ")

        # Parse text content to extract summary and other fields
        text = node.text or ""
        lines = text.split("\n")

        # Extract title (first line after #)
        title = node_name
        if lines and lines[0].startswith("#"):
            title = lines[0].replace("#", "").strip()

        # Extract summary (everything between title and ## Claims)
        summary_lines = []
        claims = []
        in_claims = False

        for line in lines[1:]:
            if line.strip().startswith("## Claims"):
                in_claims = True
                continue
            if line.strip().startswith("*Chunk ID:"):
                continue

            if in_claims:
                if line.strip().startswith("-"):
                    claims.append(line.strip()[1:].strip())
            else:
                summary_lines.append(line)

        summary = "\n".join(summary_lines).strip()

        # Determine flags from color
        is_bookmark = node.color == "5"
        is_contextual_progress = node.color == "4"

        # Find predecessor (reverse lookup in temporal_edges)
        predecessor = None
        for from_id, to_id in temporal_edges.items():
            if to_id == node.id:
                predecessor = from_id.replace("_", " ")
                break

        # Find successor
        successor = temporal_edges.get(node.id)
        if successor:
            successor = successor.replace("_", " ")

        # Build contextual_relation map
        contextual_relation = {}
        linked_nodes = []
        if node.id in contextual_edges:
            for target_id, label in contextual_edges[node.id]:
                target_name = target_id.replace("_", " ")
                contextual_relation[target_name] = label
                linked_nodes.append(target_name)

        # Also check reverse edges
        for from_id, edges_list in contextual_edges.items():
            for target_id, label in edges_list:
                if target_id == node.id:
                    source_name = from_id.replace("_", " ")
                    if source_name not in contextual_relation:
                        contextual_relation[source_name] = label
                        linked_nodes.append(source_name)

        # Create conversation node
        conv_node = {
            "node_name": title,
            "type": "conversational_thread",
            "predecessor": predecessor,
            "successor": successor,
            "chunk_id": None,  # We'll try to preserve this from metadata if possible
            "is_bookmark": is_bookmark,
            "is_contextual_progress": is_contextual_progress,
            "summary": summary,
            "claims": claims if claims else [],
            "contextual_relation": contextual_relation,
            "linked_nodes": list(set(linked_nodes))  # Remove duplicates
        }

        # Optionally preserve position data as metadata (for future use)
        if preserve_positions:
            conv_node["_canvas_metadata"] = {
                "x": node.x,
                "y": node.y,
                "width": node.width,
                "height": node.height
            }

        conversation_nodes.append(conv_node)

    # Wrap in the expected format
    graph_data = [conversation_nodes]

    return graph_data, chunk_dict


@lct_app.post("/import/obsidian-canvas/")
async def import_from_obsidian_canvas(request: CanvasImportRequest):
    """
    Import an Obsidian Canvas file and save it as a conversation.

    Args:
        request: CanvasImportRequest with canvas_data, file_name, and preserve_positions flag

    Returns:
        SaveJsonResponse with file_id and confirmation
    """
    try:
        # Convert Canvas to conversation format
        graph_data, chunk_dict = convert_canvas_to_conversation(
            request.canvas_data,
            request.preserve_positions
        )

        if not graph_data or not graph_data[0]:
            raise HTTPException(status_code=400, detail="No valid conversation nodes found in Canvas")

        # Generate a new conversation ID
        conversation_id = str(uuid.uuid4())

        # Save to GCS
        result = save_json_to_gcs(
            request.file_name,
            chunk_dict,
            graph_data,
            conversation_id
        )

        # Insert metadata into DB
        number_of_nodes = len(graph_data[0])
        metadata = {
            "id": result["file_id"],
            "conversation_name": result["file_name"],  # Database column is conversation_name
            "total_nodes": number_of_nodes,
            "gcs_path": result["gcs_path"],
            "created_at": datetime.utcnow()
        }
        print(f"[DEBUG] Canvas import - Inserting metadata: conversation_name={result['file_name']}, total_nodes={number_of_nodes}")

        await insert_conversation_metadata(metadata)

        return SaveJsonResponse(
            message=f"Successfully imported Canvas as conversation",
            file_id=result["file_id"],
            file_name=result["file_name"]
        )

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Failed to import Canvas: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Import failed: {str(e)}")
#         raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


# ============================================================================
# ANALYTICS ENDPOINTS (Week 8)
# ============================================================================

from lct_python_backend.services.speaker_analytics import SpeakerAnalytics

@lct_app.get("/api/analytics/conversations/{conversation_id}/analytics")
async def get_conversation_analytics(conversation_id: str):
    """
    Get comprehensive speaker analytics for a conversation

    Returns:
    - speakers: Dictionary of speaker statistics
    - timeline: Chronological speaker activity
    - roles: Detected speaker roles
    - summary: Overall conversation statistics
    """
    try:
        async with db.session() as session:
            analytics_service = SpeakerAnalytics(session)
            analytics = await analytics_service.calculate_full_analytics(conversation_id)

            if not analytics["speakers"]:
                raise HTTPException(
                    status_code=404,
                    detail=f"No analytics data found for conversation {conversation_id}"
                )

            return analytics

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Failed to calculate analytics: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Failed to calculate analytics: {str(e)}"
        )


@lct_app.get("/api/analytics/conversations/{conversation_id}/speakers/{speaker_id}")
async def get_speaker_stats(conversation_id: str, speaker_id: str):
    """
    Get statistics for a specific speaker in a conversation

    Returns detailed statistics for one speaker including:
    - Time spoken (seconds and percentage)
    - Turn count and percentage
    - Topics dominated
    - Detected role
    - Average turn duration
    """
    try:
        async with db.session() as session:
            analytics_service = SpeakerAnalytics(session)
            analytics = await analytics_service.calculate_full_analytics(conversation_id)

            if speaker_id not in analytics["speakers"]:
                raise HTTPException(
                    status_code=404,
                    detail=f"Speaker {speaker_id} not found in conversation {conversation_id}"
                )

            return analytics["speakers"][speaker_id]

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Failed to get speaker stats: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get speaker stats: {str(e)}"
        )


@lct_app.get("/api/analytics/conversations/{conversation_id}/timeline")
async def get_speaker_timeline(conversation_id: str):
    """
    Get chronological timeline of speaker activity

    Returns list of timeline segments showing:
    - Sequence number
    - Speaker ID and name
    - Timestamps
    - Duration
    - Text preview
    - Speaker changes
    """
    try:
        async with db.session() as session:
            analytics_service = SpeakerAnalytics(session)
            analytics = await analytics_service.calculate_full_analytics(conversation_id)

            return analytics["timeline"]

    except Exception as e:
        print(f"[ERROR] Failed to get timeline: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get timeline: {str(e)}"
        )


@lct_app.get("/api/analytics/conversations/{conversation_id}/roles")
async def get_speaker_roles(conversation_id: str):
    """
    Get detected speaker roles for a conversation

    Returns dictionary mapping speaker_id to role:
    - facilitator: Speaks frequently but briefly
    - contributor: Speaks extensively, dominates topics
    - observer: Speaks infrequently
    """
    try:
        async with db.session() as session:
            analytics_service = SpeakerAnalytics(session)
            analytics = await analytics_service.calculate_full_analytics(conversation_id)

            return analytics["roles"]

    except Exception as e:
        print(f"[ERROR] Failed to get roles: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get roles: {str(e)}"
        )


# ============================================================================
# PROMPTS CONFIGURATION ENDPOINTS (Week 9)
# ============================================================================

from lct_python_backend.services.prompt_manager import get_prompt_manager
from pydantic import BaseModel

class PromptConfigUpdate(BaseModel):
    """Request model for updating prompt configuration"""
    prompt_config: dict
    user_id: str = "anonymous"
    comment: str = ""

class PromptRestoreRequest(BaseModel):
    """Request model for restoring prompt version"""
    version_timestamp: str
    user_id: str = "anonymous"


@lct_app.get("/api/prompts")
async def list_prompts():
    """
    List all available prompts

    Returns list of prompt names
    """
    try:
        pm = get_prompt_manager()
        prompts = pm.list_prompts()
        return {"prompts": prompts, "count": len(prompts)}
    except Exception as e:
        print(f"[ERROR] Failed to list prompts: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@lct_app.get("/api/prompts/config")
async def get_prompts_config():
    """
    Get complete prompts configuration

    Returns full prompts.json content
    """
    try:
        pm = get_prompt_manager()
        config = pm.get_prompts_config()
        return config
    except Exception as e:
        print(f"[ERROR] Failed to get prompts config: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@lct_app.get("/api/prompts/{prompt_name}")
async def get_prompt(prompt_name: str):
    """
    Get a specific prompt configuration

    Args:
        prompt_name: Name of the prompt

    Returns:
        Prompt configuration dict
    """
    try:
        pm = get_prompt_manager()
        prompt = pm.get_prompt(prompt_name)
        return prompt
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        print(f"[ERROR] Failed to get prompt: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@lct_app.get("/api/prompts/{prompt_name}/metadata")
async def get_prompt_metadata(prompt_name: str):
    """
    Get prompt metadata (model, temperature, etc.) without template

    Args:
        prompt_name: Name of the prompt

    Returns:
        Metadata dict
    """
    try:
        pm = get_prompt_manager()
        metadata = pm.get_prompt_metadata(prompt_name)
        return metadata
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        print(f"[ERROR] Failed to get prompt metadata: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@lct_app.put("/api/prompts/{prompt_name}")
async def update_prompt(prompt_name: str, request: PromptConfigUpdate):
    """
    Update a prompt configuration

    Args:
        prompt_name: Name of the prompt
        request: PromptConfigUpdate with prompt_config, user_id, comment

    Returns:
        Success status and version info
    """
    try:
        pm = get_prompt_manager()

        # Validate prompt config
        validation = pm.validate_prompt(request.prompt_config)
        if not validation["valid"]:
            raise HTTPException(
                status_code=400,
                detail={"message": "Invalid prompt configuration", "errors": validation["errors"]}
            )

        # Save prompt
        result = pm.save_prompt(
            prompt_name,
            request.prompt_config,
            request.user_id,
            request.comment
        )

        return result

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Failed to update prompt: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@lct_app.delete("/api/prompts/{prompt_name}")
async def delete_prompt(prompt_name: str, user_id: str = "anonymous", comment: str = ""):
    """
    Delete a prompt

    Args:
        prompt_name: Name of the prompt to delete
        user_id: User making the deletion
        comment: Comment about the deletion

    Returns:
        Success status
    """
    try:
        pm = get_prompt_manager()
        result = pm.delete_prompt(prompt_name, user_id, comment)
        return result
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        print(f"[ERROR] Failed to delete prompt: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@lct_app.get("/api/prompts/{prompt_name}/history")
async def get_prompt_history(prompt_name: str, limit: int = 10):
    """
    Get version history for a prompt

    Args:
        prompt_name: Name of the prompt
        limit: Maximum number of versions to return

    Returns:
        List of version records
    """
    try:
        pm = get_prompt_manager()
        history = pm.get_prompt_history(prompt_name, limit)
        return {"prompt_name": prompt_name, "history": history, "count": len(history)}
    except Exception as e:
        print(f"[ERROR] Failed to get prompt history: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@lct_app.post("/api/prompts/{prompt_name}/restore")
async def restore_prompt_version(prompt_name: str, request: PromptRestoreRequest):
    """
    Restore a prompt to a previous version

    Args:
        prompt_name: Name of the prompt
        request: PromptRestoreRequest with version_timestamp and user_id

    Returns:
        Success status
    """
    try:
        pm = get_prompt_manager()
        result = pm.restore_version(
            prompt_name,
            request.version_timestamp,
            request.user_id
        )
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        print(f"[ERROR] Failed to restore prompt version: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@lct_app.post("/api/prompts/{prompt_name}/validate")
async def validate_prompt_config(prompt_name: str, prompt_config: dict):
    """
    Validate a prompt configuration without saving

    Args:
        prompt_name: Name of the prompt (for context)
        prompt_config: Prompt configuration to validate

    Returns:
        Validation result with valid: bool and errors: List[str]
    """
    try:
        pm = get_prompt_manager()
        validation = pm.validate_prompt(prompt_config)
        return validation
    except Exception as e:
        print(f"[ERROR] Failed to validate prompt: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@lct_app.post("/api/prompts/reload")
async def reload_prompts():
    """
    Force reload prompts from file (hot-reload)

    Returns:
        Success status with timestamp
    """
    try:
        pm = get_prompt_manager()
        pm.reload()
        return {
            "success": True,
            "message": "Prompts reloaded successfully",
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        print(f"[ERROR] Failed to reload prompts: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# EDIT HISTORY & TRAINING DATA EXPORT ENDPOINTS (Week 10)
# ============================================================================

from lct_python_backend.services.edit_logger import EditLogger
from lct_python_backend.services.training_data_export import TrainingDataExporter

class NodeUpdateRequest(BaseModel):
    """Request model for updating a node"""
    title: Optional[str] = None
    summary: Optional[str] = None
    keywords: Optional[List[str]] = None
    changes: Optional[dict] = None  # Diff object from frontend


@lct_app.put("/api/nodes/{node_id}")
async def update_node(node_id: str, request: NodeUpdateRequest):
    """
    Update a node and log edits for training data

    Args:
        node_id: UUID of node to update
        request: NodeUpdateRequest with title, summary, keywords, changes

    Returns:
        Updated node data
    """
    try:
        async with db.session() as session:
            # Get existing node
            from models import Node
            from sqlalchemy import select
            import uuid as uuid_module

            result = await session.execute(
                select(Node).where(Node.id == uuid_module.UUID(node_id))
            )
            node = result.scalar_one_or_none()

            if not node:
                raise HTTPException(status_code=404, detail=f"Node {node_id} not found")

            # Log edits if changes provided
            if request.changes:
                edit_logger = EditLogger(session)
                await edit_logger.log_node_edit(
                    conversation_id=str(node.conversation_id),
                    node_id=node_id,
                    changes=request.changes,
                    user_id="user",  # TODO: Get from auth
                    user_comment=None
                )

            # Update fields
            if request.title is not None:
                node.node_name = request.title
            if request.summary is not None:
                node.summary = request.summary
            if request.keywords is not None:
                node.key_points = request.keywords

            # Save
            await session.commit()
            await session.refresh(node)

            return {
                "success": True,
                "node": {
                    "id": str(node.id),
                    "title": node.node_name,
                    "summary": node.summary,
                    "keywords": node.key_points or []
                }
            }

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Failed to update node: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@lct_app.get("/api/conversations/{conversation_id}/edits")
async def get_conversation_edits(
    conversation_id: str,
    limit: Optional[int] = None,
    offset: int = 0,
    target_type: Optional[str] = None,
    unexported_only: bool = False
):
    """
    Get all edits for a conversation

    Args:
        conversation_id: UUID of conversation
        limit: Maximum number of edits to return
        offset: Number of edits to skip
        target_type: Filter by target type
        unexported_only: Only return unexported edits

    Returns:
        List of edit records
    """
    try:
        async with db.session() as session:
            edit_logger = EditLogger(session)
            edits = await edit_logger.get_edits_for_conversation(
                conversation_id,
                limit=limit,
                offset=offset,
                target_type=target_type,
                unexported_only=unexported_only
            )

            return {
                "conversation_id": conversation_id,
                "edits": [
                    {
                        "id": str(edit.id),
                        "target_type": edit.target_type,
                        "target_id": str(edit.target_id),
                        "field_name": edit.field_name,
                        "old_value": edit.old_value,
                        "new_value": edit.new_value,
                        "edit_type": edit.edit_type,
                        "user_id": edit.user_id,
                        "user_comment": edit.user_comment,
                        "user_confidence": edit.user_confidence,
                        "exported_for_training": edit.exported_for_training,
                        "training_dataset_id": edit.training_dataset_id,
                        "created_at": edit.created_at.isoformat() if edit.created_at else None
                    }
                    for edit in edits
                ],
                "count": len(edits)
            }

    except Exception as e:
        print(f"[ERROR] Failed to get edits: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@lct_app.get("/api/conversations/{conversation_id}/edits/statistics")
async def get_edit_statistics(conversation_id: str):
    """
    Get edit statistics for a conversation

    Args:
        conversation_id: UUID of conversation

    Returns:
        Statistics about edits
    """
    try:
        async with db.session() as session:
            edit_logger = EditLogger(session)
            stats = await edit_logger.get_edit_statistics(conversation_id)
            return stats

    except Exception as e:
        print(f"[ERROR] Failed to get edit statistics: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@lct_app.get("/api/conversations/{conversation_id}/training-data")
async def export_training_data(
    conversation_id: str,
    format: str = "jsonl",
    unexported_only: bool = False
):
    """
    Export training data for a conversation

    Args:
        conversation_id: UUID of conversation
        format: Export format ('jsonl', 'csv', 'markdown')
        unexported_only: Only export unexported edits

    Returns:
        Exported data as text/plain
    """
    try:
        async with db.session() as session:
            exporter = TrainingDataExporter(session)
            data = await exporter.export_conversation_edits(
                conversation_id,
                format=format,
                unexported_only=unexported_only
            )

            # Determine content type
            content_type = {
                "jsonl": "application/x-ndjson",
                "csv": "text/csv",
                "markdown": "text/markdown"
            }.get(format, "text/plain")

            # Determine filename
            dataset_id = await exporter.generate_dataset_id(conversation_id)
            extension = format
            filename = f"{dataset_id}.{extension}"

            from fastapi.responses import Response
            return Response(
                content=data,
                media_type=content_type,
                headers={
                    "Content-Disposition": f"attachment; filename={filename}"
                }
            )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        print(f"[ERROR] Failed to export training data: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@lct_app.post("/api/edits/{edit_id}/feedback")
async def add_edit_feedback(edit_id: str, feedback: dict):
    """
    Add feedback to an edit

    Args:
        edit_id: UUID of edit
        feedback: Dict with 'text' field

    Returns:
        Success status
    """
    try:
        async with db.session() as session:
            edit_logger = EditLogger(session)
            success = await edit_logger.add_feedback(
                edit_id,
                feedback.get("text", "")
            )

            if not success:
                raise HTTPException(status_code=404, detail="Edit not found")

            return {"success": True, "message": "Feedback added"}

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Failed to add feedback: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Week 11: Simulacra Level Detection
# ============================================================================

@lct_app.post("/api/conversations/{conversation_id}/simulacra/analyze")
async def analyze_simulacra_levels(
    conversation_id: str,
    force_reanalysis: bool = False
):
    """
    Analyze all nodes in a conversation for Simulacra levels

    Query params:
        force_reanalysis: Re-analyze even if already analyzed

    Returns distribution and per-node analysis
    """
    try:
        async with get_session() as session:
            from services.simulacra_detector import SimulacraDetector

            detector = SimulacraDetector(session)
            results = await detector.analyze_conversation(
                conversation_id,
                force_reanalysis=force_reanalysis
            )

            return results

    except Exception as e:
        print(f"[ERROR] Simulacra analysis failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@lct_app.get("/api/conversations/{conversation_id}/simulacra")
async def get_simulacra_results(conversation_id: str):
    """Get existing Simulacra analysis results for a conversation"""
    try:
        async with get_session() as session:
            from services.simulacra_detector import SimulacraDetector

            detector = SimulacraDetector(session)
            results = await detector.get_conversation_results(conversation_id)

            return results

    except Exception as e:
        print(f"[ERROR] Failed to get Simulacra results: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@lct_app.get("/api/nodes/{node_id}/simulacra")
async def get_node_simulacra(node_id: str):
    """Get Simulacra analysis for a specific node"""
    try:
        async with get_session() as session:
            from services.simulacra_detector import SimulacraDetector

            detector = SimulacraDetector(session)
            result = await detector.get_node_simulacra(node_id)

            if result is None:
                raise HTTPException(
                    status_code=404,
                    detail="No Simulacra analysis found for this node"
                )

            return result

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Failed to get node Simulacra: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Week 12: Cognitive Bias Detection
# ============================================================================

@lct_app.post("/api/conversations/{conversation_id}/biases/analyze")
async def analyze_cognitive_biases(
    conversation_id: str,
    force_reanalysis: bool = False
):
    """
    Analyze all nodes in a conversation for cognitive biases

    Query params:
        force_reanalysis: Re-analyze even if already analyzed

    Returns bias distribution and per-node analysis
    """
    try:
        async with get_session() as session:
            from services.bias_detector import BiasDetector

            detector = BiasDetector(session)
            results = await detector.analyze_conversation(
                conversation_id,
                force_reanalysis=force_reanalysis
            )

            return results

    except Exception as e:
        print(f"[ERROR] Bias analysis failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@lct_app.get("/api/conversations/{conversation_id}/biases")
async def get_bias_results(conversation_id: str):
    """Get existing cognitive bias analysis results for a conversation"""
    try:
        async with get_session() as session:
            from services.bias_detector import BiasDetector

            detector = BiasDetector(session)
            results = await detector.get_conversation_results(conversation_id)

            return results

    except Exception as e:
        print(f"[ERROR] Failed to get bias results: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@lct_app.get("/api/nodes/{node_id}/biases")
async def get_node_biases(node_id: str):
    """Get cognitive bias analyses for a specific node"""
    try:
        async with get_session() as session:
            from services.bias_detector import BiasDetector

            detector = BiasDetector(session)
            biases = await detector.get_node_biases(node_id)

            return {"biases": biases}

    except Exception as e:
        print(f"[ERROR] Failed to get node biases: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Week 13: Implicit Frame Detection
# ============================================================================

@lct_app.post("/api/conversations/{conversation_id}/frames/analyze")
async def analyze_implicit_frames(
    conversation_id: str,
    force_reanalysis: bool = False
):
    """
    Analyze all nodes in a conversation for implicit frames

    Query params:
        force_reanalysis: Re-analyze even if already analyzed

    Returns frame distribution and per-node analysis
    """
    try:
        async with get_session() as session:
            from services.frame_detector import FrameDetector

            detector = FrameDetector(session)
            results = await detector.analyze_conversation(
                conversation_id,
                force_reanalysis=force_reanalysis
            )

            return results

    except Exception as e:
        print(f"[ERROR] Frame analysis failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@lct_app.get("/api/conversations/{conversation_id}/frames")
async def get_frame_results(conversation_id: str):
    """Get existing implicit frame analysis results for a conversation"""
    try:
        async with get_session() as session:
            from services.frame_detector import FrameDetector

            detector = FrameDetector(session)
            results = await detector.get_conversation_results(conversation_id)

            return results

    except Exception as e:
        print(f"[ERROR] Failed to get frame results: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@lct_app.get("/api/nodes/{node_id}/frames")
async def get_node_frames(node_id: str):
    """Get implicit frame analyses for a specific node"""
    try:
        async with get_session() as session:
            from services.frame_detector import FrameDetector

            detector = FrameDetector(session)
            frames = await detector.get_node_frames(node_id)

            return {"frames": frames}

    except Exception as e:
        print(f"[ERROR] Failed to get node frames: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Thematic Analysis (Hierarchical Coarse-Graining)
# ============================================================================

async def delete_all_thematic_nodes(conversation_id: str, db: AsyncSession) -> int:
    """
    Delete all thematic nodes (levels 1-5) and their relationships for a conversation.
    Used before regenerating themes to ensure clean state.

    Returns: Total count of deleted nodes
    """
    from sqlalchemy import delete, and_, or_, select
    from lct_python_backend.models import Node, Relationship

    conv_uuid = uuid.UUID(conversation_id)

    # Get all node IDs for levels 1-5
    existing_result = await db.execute(
        select(Node.id).where(
            and_(
                Node.conversation_id == conv_uuid,
                Node.level >= 1,
                Node.level <= 5
            )
        )
    )
    node_ids = [row[0] for row in existing_result.fetchall()]

    if not node_ids:
        return 0

    # Delete relationships involving these nodes
    await db.execute(
        delete(Relationship).where(
            and_(
                Relationship.conversation_id == conv_uuid,
                or_(
                    Relationship.from_node_id.in_(node_ids),
                    Relationship.to_node_id.in_(node_ids)
                )
            )
        )
    )

    # Delete the nodes
    await db.execute(
        delete(Node).where(
            and_(
                Node.conversation_id == conv_uuid,
                Node.level >= 1,
                Node.level <= 5
            )
        )
    )

    await db.commit()
    logger.info(f"[CLEANUP] Deleted {len(node_ids)} thematic nodes for conversation {conversation_id}")
    return len(node_ids)


async def generate_hierarchical_levels_background(
    conversation_id: str,
    model: str = "anthropic/claude-3.5-sonnet",
    utterances_per_atomic_theme: int = 5,
    clustering_ratio: float = 2.5,
    force_regenerate: bool = True
):
    """
    Background task: Generate all thematic levels L5 → L4 → L3 → L2 → L1.

    Single bottom-up tree generation:
    - L5: Generate atomic themes from utterances (~1 theme per 5 utterances)
    - L4: Cluster L5 → fine themes
    - L3: Cluster L4 → medium themes
    - L2: Cluster L3 → themes (major topics)
    - L1: Cluster L2 → mega-themes (big picture)

    Args:
        conversation_id: UUID of conversation
        model: OpenRouter model ID
        utterances_per_atomic_theme: Target utterances per L5 node (default: 5)
        clustering_ratio: How many children per parent (default: 2.5)
        force_regenerate: If True, delete existing nodes first (default: True)
    """
    logger.info("=" * 50)
    logger.info(f"[BACKGROUND] === HIERARCHICAL GENERATION STARTED ===")
    logger.info(f"[BACKGROUND] conversation_id: {conversation_id}")
    logger.info(f"[BACKGROUND] model: {model}")
    logger.info(f"[BACKGROUND] utterances_per_atomic_theme: {utterances_per_atomic_theme}")
    logger.info(f"[BACKGROUND] clustering_ratio: {clustering_ratio}")
    logger.info("=" * 50)

    try:
        from lct_python_backend.db_session import get_async_session_context
        from lct_python_backend.services.hierarchical_themes import (
            Level5AtomicGenerator,
            Level4Clusterer,
            Level3Clusterer,
            Level2Clusterer,
            Level1Clusterer
        )
        from lct_python_backend.models import Utterance
        from sqlalchemy import select
        logger.info("[BACKGROUND] Imports successful")
    except Exception as e:
        logger.error(f"[BACKGROUND] Import failed: {e}", exc_info=True)
        return

    try:
        async with get_async_session_context() as db:
            # Clean up if force regenerate
            if force_regenerate:
                deleted = await delete_all_thematic_nodes(conversation_id, db)
                logger.info(f"[BACKGROUND] Cleaned up {deleted} existing nodes")

            # Fetch utterances
            result = await db.execute(
                select(Utterance).where(
                    Utterance.conversation_id == uuid.UUID(conversation_id)
                ).order_by(Utterance.sequence_number)
            )
            utterances = list(result.scalars().all())

            if not utterances:
                logger.warning(f"[BACKGROUND] No utterances found for conversation {conversation_id}")
                return

            logger.info(f"[BACKGROUND] Found {len(utterances)} utterances")

            # L5: Generate atomic themes from utterances
            logger.info("[BACKGROUND] Step 1/5: Generating Level 5 (atomic themes)...")
            l5_generator = Level5AtomicGenerator(
                db, model=model,
                utterances_per_theme=utterances_per_atomic_theme
            )
            l5_nodes = await l5_generator.get_or_generate(
                conversation_id=conversation_id,
                utterances=utterances,
                force_regenerate=False  # Already cleaned up
            )
            logger.info(f"[BACKGROUND] Level 5 complete: {len(l5_nodes)} atomic themes")

            # L4: Cluster L5 → L4
            logger.info("[BACKGROUND] Step 2/5: Generating Level 4 (fine themes)...")
            l4_clusterer = Level4Clusterer(db, model=model, clustering_ratio=clustering_ratio)
            l4_nodes = await l4_clusterer.get_or_generate(
                conversation_id=conversation_id,
                parent_nodes=l5_nodes,
                utterances=utterances,
                force_regenerate=False
            )
            logger.info(f"[BACKGROUND] Level 4 complete: {len(l4_nodes)} fine themes")

            # L3: Cluster L4 → L3
            logger.info("[BACKGROUND] Step 3/5: Generating Level 3 (medium themes)...")
            l3_clusterer = Level3Clusterer(db, model=model, clustering_ratio=clustering_ratio)
            l3_nodes = await l3_clusterer.get_or_generate(
                conversation_id=conversation_id,
                parent_nodes=l4_nodes,
                utterances=utterances,
                force_regenerate=False
            )
            logger.info(f"[BACKGROUND] Level 3 complete: {len(l3_nodes)} medium themes")

            # L2: Cluster L3 → L2 (NEW - was independent before)
            logger.info("[BACKGROUND] Step 4/5: Generating Level 2 (themes)...")
            l2_clusterer = Level2Clusterer(db, model=model, clustering_ratio=clustering_ratio)
            l2_nodes = await l2_clusterer.get_or_generate(
                conversation_id=conversation_id,
                parent_nodes=l3_nodes,
                utterances=utterances,
                force_regenerate=False
            )
            logger.info(f"[BACKGROUND] Level 2 complete: {len(l2_nodes)} themes")

            # L1: Cluster L2 → L1
            logger.info("[BACKGROUND] Step 5/5: Generating Level 1 (mega-themes)...")
            l1_clusterer = Level1Clusterer(db, model=model, clustering_ratio=clustering_ratio)
            l1_nodes = await l1_clusterer.get_or_generate(
                conversation_id=conversation_id,
                parent_nodes=l2_nodes,
                utterances=utterances,
                force_regenerate=False
            )
            logger.info(f"[BACKGROUND] Level 1 complete: {len(l1_nodes)} mega-themes")

            logger.info("=" * 50)
            logger.info(f"[BACKGROUND] === HIERARCHICAL GENERATION COMPLETE ===")
            logger.info(f"[BACKGROUND] L5: {len(l5_nodes)} | L4: {len(l4_nodes)} | L3: {len(l3_nodes)} | L2: {len(l2_nodes)} | L1: {len(l1_nodes)}")
            logger.info("=" * 50)

    except Exception as e:
        logger.error(f"[BACKGROUND] Failed to generate hierarchical levels: {e}", exc_info=True)

@lct_app.post("/api/conversations/{conversation_id}/themes/generate")
async def generate_thematic_structure(
    conversation_id: str,
    background_tasks: BackgroundTasks,
    model: str = "anthropic/claude-3.5-sonnet",
    utterances_per_atomic_theme: int = 5,
    clustering_ratio: float = 2.5,
    force_regenerate: bool = True,
    db: AsyncSession = Depends(get_async_session)
):
    """
    Generate thematic structure for a conversation using AI.

    Kicks off background generation of all hierarchical levels:
    L5 (atomic) → L4 (fine) → L3 (medium) → L2 (themes) → L1 (mega)

    All levels form a single coherent tree where each level clusters its children.

    Args:
        conversation_id: UUID of conversation
        model: OpenRouter model ID (default claude-3.5-sonnet)
        utterances_per_atomic_theme: Target utterances per L5 node (default: 5)
        clustering_ratio: How many children per parent node (default: 2.5)
        force_regenerate: Delete existing themes and regenerate (default: True)

    Returns:
        {
            "status": "generating",
            "message": "Background generation started",
            "levels_generating": [5, 4, 3, 2, 1],
            "config": {...}
        }
    """
    try:
        from sqlalchemy import select
        from lct_python_backend.models import Conversation, Utterance

        # Validate conversation exists
        conv_result = await db.execute(
            select(Conversation).where(Conversation.id == uuid.UUID(conversation_id))
        )
        conversation = conv_result.scalar_one_or_none()
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversation not found")

        # Check utterance count
        utt_result = await db.execute(
            select(func.count(Utterance.id)).where(
                Utterance.conversation_id == uuid.UUID(conversation_id)
            )
        )
        utterance_count = utt_result.scalar()

        if utterance_count == 0:
            raise HTTPException(status_code=400, detail="Conversation has no utterances")

        # Kick off background task
        background_tasks.add_task(
            generate_hierarchical_levels_background,
            conversation_id=conversation_id,
            model=model,
            utterances_per_atomic_theme=utterances_per_atomic_theme,
            clustering_ratio=clustering_ratio,
            force_regenerate=force_regenerate
        )

        logger.info(f"[GENERATE] Started background generation for {conversation_id}")

        return {
            "status": "generating",
            "message": "Background generation started for all hierarchical levels",
            "levels_generating": [5, 4, 3, 2, 1],
            "utterance_count": utterance_count,
            "config": {
                "model": model,
                "utterances_per_atomic_theme": utterances_per_atomic_theme,
                "clustering_ratio": clustering_ratio,
                "force_regenerate": force_regenerate
            }
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[ERROR] Failed to start thematic generation: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@lct_app.get("/api/conversations/{conversation_id}/themes")
async def get_thematic_structure(
    conversation_id: str,
    level: Optional[int] = 2,
    db: AsyncSession = Depends(get_async_session)
):
    """
    Get existing thematic structure for a conversation at a specific level

    Args:
        conversation_id: UUID of conversation
        level: Which hierarchical level to fetch (0-5, default 2)
            - 0: Utterances (raw transcript)
            - 1: Mega-themes (3-5 nodes)
            - 2: Themes (10-15 nodes) - default
            - 3: Medium detail (20-30 nodes)
            - 4: Fine detail (40-60 nodes)
            - 5: Atomic themes (60-120 nodes)

    Returns thematic nodes and edges if they exist, otherwise empty.
    """
    try:
        from lct_python_backend.services.thematic_analyzer import ThematicAnalyzer
        from lct_python_backend.models import Node, Relationship, Utterance
        from sqlalchemy import select, and_
        import uuid

        conv_uuid = uuid.UUID(conversation_id)

        # Validate level
        if level not in [0, 1, 2, 3, 4, 5]:
            raise HTTPException(status_code=400, detail="Level must be 0, 1, 2, 3, 4, or 5")

        # Level 0: Return utterances as nodes
        if level == 0:
            result = await db.execute(
                select(Utterance)
                .where(Utterance.conversation_id == conv_uuid)
                .order_by(Utterance.sequence_number)
            )
            utterances = result.scalars().all()

            # Format utterances as thematic nodes for consistent display
            thematic_nodes = []
            for utt in utterances:
                thematic_nodes.append({
                    "id": str(utt.id),
                    "label": f"[{utt.sequence_number}] {utt.speaker_name or utt.speaker_id}",
                    "summary": utt.text[:500] if utt.text else "",
                    "node_type": "utterance",
                    "utterance_ids": [str(utt.id)],
                    "timestamp_start": utt.timestamp_start,
                    "timestamp_end": utt.timestamp_end,
                })

            # Create sequential edges between consecutive utterances
            edges = []
            for i in range(len(thematic_nodes) - 1):
                edges.append({
                    "source": thematic_nodes[i]["id"],
                    "target": thematic_nodes[i + 1]["id"],
                    "type": "follows",
                })

            return {
                "thematic_nodes": thematic_nodes,
                "edges": edges,
                "summary": {
                    "total_themes": len(thematic_nodes),
                    "exists": True,
                    "level": 0,
                    "description": "Raw utterances"
                }
            }

        # Fetch nodes for requested level (1-5)
        result = await db.execute(
            select(Node).where(
                and_(
                    Node.conversation_id == conv_uuid,
                    Node.level == level
                )
            )
        )
        nodes = result.scalars().all()

        if not nodes:
            return {
                "thematic_nodes": [],
                "edges": [],
                "summary": {
                    "total_themes": 0,
                    "exists": False,
                    "level": level
                }
            }

        # Serialize existing structure
        analyzer = ThematicAnalyzer(db)
        structure = await analyzer._serialize_existing_structure(nodes, conversation_id)
        structure["summary"]["exists"] = True
        structure["summary"]["level"] = level

        return structure

    except Exception as e:
        print(f"[ERROR] Failed to get thematic structure: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@lct_app.get("/api/conversations/{conversation_id}/themes/levels")
async def get_available_levels(
    conversation_id: str,
    db: AsyncSession = Depends(get_async_session)
):
    """
    Check which hierarchical levels have been generated for this conversation

    Used by frontend to poll for availability of levels during background generation.

    Returns:
        {
            "available_levels": [2, 5],  # Levels that exist
            "generating": [1, 3, 4],     # Levels presumably being generated
            "level_counts": {
                "1": 0,
                "2": 12,
                "3": 0,
                "4": 0,
                "5": 87
            }
        }
    """
    try:
        from lct_python_backend.models import Node, Utterance
        from sqlalchemy import select, and_, func
        import uuid

        conv_uuid = uuid.UUID(conversation_id)

        # Query for count of nodes at each level (1-5)
        result = await db.execute(
            select(
                Node.level,
                func.count(Node.id).label('count')
            ).where(
                Node.conversation_id == conv_uuid
            ).group_by(Node.level)
        )

        level_counts = {row.level: row.count for row in result}

        # Query for utterance count (Level 0)
        utt_result = await db.execute(
            select(func.count(Utterance.id)).where(
                Utterance.conversation_id == conv_uuid
            )
        )
        utterance_count = utt_result.scalar() or 0

        # Add Level 0 (utterances) to counts
        level_counts[0] = utterance_count

        # Determine available levels (those with nodes)
        # Level 0 is always available if there are utterances
        available_levels = sorted([level for level, count in level_counts.items() if count > 0])

        # Infer which levels are being generated
        # If L5 exists but not all levels 1-5, assume background generation is in progress
        thematic_levels = [1, 2, 3, 4, 5]
        thematic_available = [l for l in available_levels if l in thematic_levels]
        if 5 in thematic_available and set(thematic_available) != set(thematic_levels):
            generating = [level for level in thematic_levels if level not in thematic_available]
        else:
            generating = []

        return {
            "available_levels": available_levels,
            "generating": generating,
            "level_counts": {str(k): v for k, v in level_counts.items()}
        }

    except Exception as e:
        print(f"[ERROR] Failed to get available levels: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@lct_app.get("/api/conversations/{conversation_id}/utterances")
async def get_conversation_utterances(
    conversation_id: str,
    db: AsyncSession = Depends(get_async_session)
):
    """
    Get all utterances for a conversation

    Returns utterances ordered by sequence number for timeline display.
    """
    try:
        from lct_python_backend.models import Utterance
        from sqlalchemy import select
        import uuid

        result = await db.execute(
            select(Utterance)
            .where(Utterance.conversation_id == uuid.UUID(conversation_id))
            .order_by(Utterance.sequence_number)
        )
        utterances = result.scalars().all()

        # Serialize utterances
        utterances_data = [
            {
                "id": str(utt.id),
                "conversation_id": str(utt.conversation_id),
                "sequence_number": utt.sequence_number,
                "speaker_id": utt.speaker_id,
                "speaker_name": utt.speaker_name,
                "text": utt.text,
                "timestamp_start": utt.timestamp_start,
                "timestamp_end": utt.timestamp_end,
                "duration_seconds": utt.duration_seconds,
            }
            for utt in utterances
        ]

        return {
            "utterances": utterances_data,
            "total": len(utterances_data)
        }

    except Exception as e:
        print(f"[ERROR] Failed to get utterances: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Cost Tracking Dashboard
# ============================================================================

@lct_app.get("/api/cost-tracking/stats")
async def get_cost_stats(time_range: str = "7d"):
    """
    Get API cost statistics

    Query params:
        time_range: 1d, 7d, 30d, or all

    Returns aggregated cost data by feature, model, and time
    """
    try:
        # Mock data for now - in production this would query api_calls_log table
        # TODO: Implement real database queries when api_calls_log is populated

        mock_data = {
            "total_cost": 12.45,
            "total_calls": 450,
            "total_tokens": 125000,
            "avg_cost_per_call": 0.0277,
            "avg_tokens_per_call": 278,
            "conversations_analyzed": 15,
            "by_feature": {
                "simulacra_detection": {
                    "cost": 3.20,
                    "calls": 150,
                    "tokens": 40000
                },
                "bias_detection": {
                    "cost": 4.50,
                    "calls": 150,
                    "tokens": 45000
                },
                "frame_detection": {
                    "cost": 4.75,
                    "calls": 150,
                    "tokens": 40000
                }
            },
            "by_model": {
                "claude-3-5-sonnet-20241022": {
                    "cost": 12.45,
                    "calls": 450,
                    "tokens": 125000
                }
            },
            "recent_calls": [
                {
                    "timestamp": "2025-11-12T12:30:00Z",
                    "endpoint": "frame_detection",
                    "model": "claude-3-5-sonnet-20241022",
                    "total_tokens": 350,
                    "cost_usd": 0.035,
                    "latency_ms": 2500
                },
                {
                    "timestamp": "2025-11-12T12:25:00Z",
                    "endpoint": "bias_detection",
                    "model": "claude-3-5-sonnet-20241022",
                    "total_tokens": 280,
                    "cost_usd": 0.028,
                    "latency_ms": 2100
                },
                {
                    "timestamp": "2025-11-12T12:20:00Z",
                    "endpoint": "simulacra_detection",
                    "model": "claude-3-5-sonnet-20241022",
                    "total_tokens": 200,
                    "cost_usd": 0.020,
                    "latency_ms": 1800
                }
            ]
        }

        return mock_data

    except Exception as e:
        print(f"[ERROR] Failed to get cost stats: {e}")
        raise HTTPException(status_code=500, detail=str(e))
