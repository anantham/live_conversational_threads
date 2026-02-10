"""LLM call helpers — Claude API wrapper and JSON generation."""
import json
import time
import random
import anthropic
from typing import Dict, Generator, List

from lct_python_backend.config import ANTHROPIC_API_KEY
from lct_python_backend.services.transcript_processing import generate_lct_json


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
-\tIn "contextual_relation", provide integrated explanations that naturally weave together:
-\tHow nodes connect thematically (shared concepts, related ideas)
-\tHow concepts have evolved or been refined since previous mentions
-\tHow ideas build upon each other across different conversation segments
-\t Don't capture direct shifts in conversations as contextual_relation unless there is a relevant contextual relation only then capture it.
Create cohesive narratives that explain the full relationship context rather than treating these as separate analytical dimensions.

**Define Structure:**
"predecessor" → The direct previous node temporally (empty for first node only).
"successor" → The direct next node temporally.
"contextual_relation" → Use this to explain how past nodes contribute to the current discussion contextually.
•\tKeys = node names that contribute context.
•\tValues = a detailed explanation of how the multiple referenced nodes influence the current discussion.

"linked_nodes" → A comprehensive list of all nodes this node is either drawing context from or providing context to, this information of context providing will come from "contextual_relation", consolidating references into a single field.
"chunk_id" → This field will be ignored for now, as it will be added externally by the code.

**Handling Updates to Existing JSON**
If an existing JSON structure is provided along with the transcript, modify it as follows and strictly return only the nodes generated for the current input transcript:

- **Continuing a topic**: If the conversation continues an existing discussion, update the "successor" field of the last relevant node.
-\t**New topic**: If a conversation introduces a new topic, create a new node and properly link it.
-\t**Revisiting a Bookmark**: If "LLM wish bookmark open [name]" appears, find the existing bookmark node and update its "contextual_relation" and "linked_nodes". Do NOT create a new bookmark when revisited—update the existing one instead.
-\t**Contextual Relation Updates**: Maintain connections that demonstrate how past discussions influence current ones through integrated thematic, evolutionary, and developmental relationships.

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
-\tOnly If "LLM wish capture contextual progress" appears, update the existing node (either "conversational_thread" or "bookmark") to include:
o\t"is_contextual_progress": true
-\tContextual progress capture is used to capture a potential insight that might be present in that conversational node.
-\tIt represents part of the conversation that could potentially be an insight that could be useful. These "potential insights" are the directions provided by humans that can later be taken by AI, which then uses this to generate formalisms.
-\tDo not create a new node for contextual progress capture. Instead, apply the flag to the relevant existing node where the potential insight was introduced or referenced.
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


def sliding_window_chunking(text: str, chunk_size: int = 10000, overlap: int = 2000) -> Dict[str, str]:
    import uuid
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
