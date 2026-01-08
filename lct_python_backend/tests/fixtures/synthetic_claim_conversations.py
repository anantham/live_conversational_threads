"""
Synthetic test conversations for claim detection testing.

Contains examples of factual, normative, and worldview claims
for validating the three-layer taxonomy detection.
"""

# Conversation 1: Economic Policy Discussion
ECONOMIC_POLICY_CONVERSATION = {
    "title": "Economic Growth vs. Inequality",
    "utterances": [
        {
            "speaker": "Alice",
            "text": "GDP grew by 3.2% last quarter according to the latest report.",
            "expected_claims": [
                {
                    "claim_type": "factual",
                    "claim_text": "GDP grew by 3.2% last quarter",
                    "is_verifiable": True,
                }
            ]
        },
        {
            "speaker": "Bob",
            "text": "That's good, but we should prioritize reducing income inequality over pure growth.",
            "expected_claims": [
                {
                    "claim_type": "normative",
                    "claim_text": "We should prioritize reducing income inequality over pure growth",
                    "normative_type": "prescription",
                    "implicit_values": ["fairness", "equality"],
                }
            ]
        },
        {
            "speaker": "Alice",
            "text": "But a rising tide lifts all boats. Economic growth naturally benefits everyone.",
            "expected_claims": [
                {
                    "claim_type": "worldview",
                    "claim_text": "Economic growth naturally benefits everyone",
                    "worldview_category": "economic_neoliberal",
                    "hidden_premises": [
                        "Markets efficiently distribute benefits",
                        "Growth is inherently good",
                        "Trickle-down economics works"
                    ],
                    "ideological_markers": ["rising tide lifts all boats"]
                }
            ]
        },
        {
            "speaker": "Bob",
            "text": "The top 1% captured 50% of the growth in the last decade.",
            "expected_claims": [
                {
                    "claim_type": "factual",
                    "claim_text": "The top 1% captured 50% of the growth in the last decade",
                    "is_verifiable": True,
                }
            ]
        },
    ]
}


# Conversation 2: AI Safety Discussion
AI_SAFETY_CONVERSATION = {
    "title": "AI Alignment and Safety",
    "utterances": [
        {
            "speaker": "Charlie",
            "text": "We must slow down AI development to ensure safety.",
            "expected_claims": [
                {
                    "claim_type": "normative",
                    "claim_text": "We must slow down AI development to ensure safety",
                    "normative_type": "obligation",
                    "implicit_values": ["safety", "caution", "control"],
                }
            ]
        },
        {
            "speaker": "Diana",
            "text": "OpenAI's GPT-4 was released in March 2023.",
            "expected_claims": [
                {
                    "claim_type": "factual",
                    "claim_text": "OpenAI's GPT-4 was released in March 2023",
                    "is_verifiable": True,
                }
            ]
        },
        {
            "speaker": "Charlie",
            "text": "Progress requires taking risks. Innovation has always been about pushing boundaries.",
            "expected_claims": [
                {
                    "claim_type": "worldview",
                    "claim_text": "Progress requires taking risks",
                    "worldview_category": "techno_optimist",
                    "hidden_premises": [
                        "Innovation is inherently good",
                        "Risk is necessary for progress",
                        "Future benefits outweigh present dangers"
                    ],
                    "ideological_markers": ["pushing boundaries", "progress requires"]
                }
            ]
        },
        {
            "speaker": "Diana",
            "text": "I think AI will be beneficial overall, but we need safeguards.",
            "expected_claims": [
                {
                    "claim_type": "normative",
                    "claim_text": "We need safeguards for AI",
                    "normative_type": "prescription",
                    "implicit_values": ["safety", "prudence"],
                },
                {
                    "claim_type": "normative",
                    "claim_text": "AI will be beneficial overall",
                    "normative_type": "evaluation",
                    "implicit_values": ["optimism", "progress"],
                }
            ]
        },
    ]
}


# Conversation 3: Climate Change Discussion
CLIMATE_CONVERSATION = {
    "title": "Climate Policy Debate",
    "utterances": [
        {
            "speaker": "Eve",
            "text": "Global temperatures have risen 1.1°C since pre-industrial times.",
            "expected_claims": [
                {
                    "claim_type": "factual",
                    "claim_text": "Global temperatures have risen 1.1°C since pre-industrial times",
                    "is_verifiable": True,
                }
            ]
        },
        {
            "speaker": "Frank",
            "text": "Humans evolved to adapt to changing climates, so we'll naturally adjust to warming.",
            "expected_claims": [
                {
                    "claim_type": "worldview",
                    "claim_text": "We'll naturally adjust to warming because humans evolved to adapt",
                    "worldview_category": "naturalistic_fallacy",
                    "hidden_premises": [
                        "What is natural is good",
                        "Past adaptation guarantees future success",
                        "Evolution optimizes for survival"
                    ],
                    "ideological_markers": ["naturally", "evolved to"]
                }
            ]
        },
        {
            "speaker": "Eve",
            "text": "We have a moral obligation to future generations to act now.",
            "expected_claims": [
                {
                    "claim_type": "normative",
                    "claim_text": "We have a moral obligation to future generations to act now",
                    "normative_type": "obligation",
                    "implicit_values": ["intergenerational justice", "responsibility"],
                }
            ]
        },
        {
            "speaker": "Frank",
            "text": "The IPCC's latest report projects 2-4°C warming by 2100 under current policies.",
            "expected_claims": [
                {
                    "claim_type": "factual",
                    "claim_text": "The IPCC projects 2-4°C warming by 2100 under current policies",
                    "is_verifiable": True,
                }
            ]
        },
    ]
}


# Conversation 4: Healthcare Debate
HEALTHCARE_CONVERSATION = {
    "title": "Universal Healthcare Debate",
    "utterances": [
        {
            "speaker": "Grace",
            "text": "The US spends $4.3 trillion annually on healthcare.",
            "expected_claims": [
                {
                    "claim_type": "factual",
                    "claim_text": "The US spends $4.3 trillion annually on healthcare",
                    "is_verifiable": True,
                }
            ]
        },
        {
            "speaker": "Henry",
            "text": "Healthcare is a human right and should be provided to everyone.",
            "expected_claims": [
                {
                    "claim_type": "normative",
                    "claim_text": "Healthcare is a human right and should be provided to everyone",
                    "normative_type": "prescription",
                    "implicit_values": ["equality", "human dignity", "solidarity"],
                }
            ]
        },
        {
            "speaker": "Grace",
            "text": "Free markets always produce better outcomes than government programs.",
            "expected_claims": [
                {
                    "claim_type": "worldview",
                    "claim_text": "Free markets always produce better outcomes than government programs",
                    "worldview_category": "economic_libertarian",
                    "hidden_premises": [
                        "Markets are inherently efficient",
                        "Government is inherently inefficient",
                        "Individual choice maximizes welfare"
                    ],
                    "ideological_markers": ["free markets", "always produce better"]
                }
            ]
        },
        {
            "speaker": "Henry",
            "text": "Countries with universal healthcare have better health outcomes at lower cost.",
            "expected_claims": [
                {
                    "claim_type": "factual",
                    "claim_text": "Countries with universal healthcare have better health outcomes at lower cost",
                    "is_verifiable": True,
                }
            ]
        },
    ]
}


# Conversation 5: Education Discussion
EDUCATION_CONVERSATION = {
    "title": "Education Reform",
    "utterances": [
        {
            "speaker": "Iris",
            "text": "The average college graduate earns $1 million more over their lifetime.",
            "expected_claims": [
                {
                    "claim_type": "factual",
                    "claim_text": "The average college graduate earns $1 million more over their lifetime",
                    "is_verifiable": True,
                }
            ]
        },
        {
            "speaker": "Jack",
            "text": "Education should focus on practical skills rather than abstract theory.",
            "expected_claims": [
                {
                    "claim_type": "normative",
                    "claim_text": "Education should focus on practical skills rather than abstract theory",
                    "normative_type": "prescription",
                    "implicit_values": ["pragmatism", "utility", "efficiency"],
                }
            ]
        },
        {
            "speaker": "Iris",
            "text": "Humans naturally learn best through hands-on experience, not lectures.",
            "expected_claims": [
                {
                    "claim_type": "worldview",
                    "claim_text": "Humans naturally learn best through hands-on experience",
                    "worldview_category": "appeal_to_nature",
                    "hidden_premises": [
                        "Natural learning is superior",
                        "Evolution optimized learning methods",
                        "Traditional methods are wrong"
                    ],
                    "ideological_markers": ["naturally", "learn best"]
                }
            ]
        },
    ]
}


# All test conversations
ALL_TEST_CONVERSATIONS = [
    ECONOMIC_POLICY_CONVERSATION,
    AI_SAFETY_CONVERSATION,
    CLIMATE_CONVERSATION,
    HEALTHCARE_CONVERSATION,
    EDUCATION_CONVERSATION,
]


def get_test_conversation(index: int = 0):
    """Get a test conversation by index."""
    return ALL_TEST_CONVERSATIONS[index]


def get_all_test_conversations():
    """Get all test conversations."""
    return ALL_TEST_CONVERSATIONS
