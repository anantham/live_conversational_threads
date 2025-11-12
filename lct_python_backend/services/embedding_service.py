"""
Embedding Service for semantic search using OpenAI's text-embedding-3-small.

Generates 1536-dimensional vectors for claims, nodes, and utterances
to enable cross-conversation semantic search.
"""

import os
import asyncio
from typing import List, Dict, Any
import openai
from openai import AsyncOpenAI


class EmbeddingService:
    """
    Service for generating text embeddings using OpenAI API.

    Uses text-embedding-3-small model:
    - 1536 dimensions
    - $0.02 / 1M tokens
    - Fast and cost-effective
    """

    MODEL = "text-embedding-3-small"
    DIMENSIONS = 1536
    MAX_BATCH_SIZE = 100  # OpenAI limit

    def __init__(self):
        """Initialize embedding service with OpenAI client."""
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError(
                "OPENAI_API_KEY not found in environment. "
                "Please set it to use embedding service."
            )

        self.client = AsyncOpenAI(api_key=api_key)

    async def embed_text(self, text: str) -> List[float]:
        """
        Generate embedding for a single text.

        Args:
            text: Input text to embed

        Returns:
            List of 1536 floats representing the embedding

        Raises:
            Exception: If OpenAI API call fails
        """
        if not text or not text.strip():
            raise ValueError("Cannot embed empty text")

        try:
            response = await self.client.embeddings.create(
                model=self.MODEL,
                input=text,
                encoding_format="float"
            )

            embedding = response.data[0].embedding
            return embedding

        except Exception as e:
            print(f"Error generating embedding: {e}")
            raise

    async def embed_batch(
        self,
        texts: List[str],
        batch_size: int = 50
    ) -> List[List[float]]:
        """
        Generate embeddings for multiple texts efficiently.

        Args:
            texts: List of texts to embed
            batch_size: Number of texts per API call (max 100)

        Returns:
            List of embeddings in same order as input texts

        Raises:
            Exception: If OpenAI API call fails
        """
        if not texts:
            return []

        # Filter empty texts
        valid_texts = [(i, text) for i, text in enumerate(texts) if text and text.strip()]
        if not valid_texts:
            raise ValueError("All texts are empty")

        # Process in batches
        all_embeddings = [None] * len(texts)
        batch_size = min(batch_size, self.MAX_BATCH_SIZE)

        for i in range(0, len(valid_texts), batch_size):
            batch = valid_texts[i:i + batch_size]
            batch_texts = [text for _, text in batch]
            batch_indices = [idx for idx, _ in batch]

            try:
                response = await self.client.embeddings.create(
                    model=self.MODEL,
                    input=batch_texts,
                    encoding_format="float"
                )

                # Map embeddings back to original indices
                for j, embedding_obj in enumerate(response.data):
                    original_idx = batch_indices[j]
                    all_embeddings[original_idx] = embedding_obj.embedding

            except Exception as e:
                print(f"Error generating batch embeddings: {e}")
                raise

            # Rate limiting: small delay between batches
            if i + batch_size < len(valid_texts):
                await asyncio.sleep(0.1)

        return all_embeddings

    async def embed_claim(self, claim_text: str, claim_type: str) -> List[float]:
        """
        Generate embedding for a claim with type context.

        Prepends claim type to provide better context for embedding.

        Args:
            claim_text: The claim text
            claim_type: 'factual', 'normative', or 'worldview'

        Returns:
            1536-dimensional embedding
        """
        # Add type context for better semantic representation
        contextualized_text = f"[{claim_type.upper()}] {claim_text}"
        return await self.embed_text(contextualized_text)

    async def embed_claims_batch(
        self,
        claims: List[Dict[str, str]]
    ) -> List[List[float]]:
        """
        Generate embeddings for multiple claims with type context.

        Args:
            claims: List of dicts with 'claim_text' and 'claim_type' keys

        Returns:
            List of embeddings
        """
        contextualized_texts = [
            f"[{claim['claim_type'].upper()}] {claim['claim_text']}"
            for claim in claims
        ]

        return await self.embed_batch(contextualized_texts)

    def cosine_similarity(
        self,
        embedding1: List[float],
        embedding2: List[float]
    ) -> float:
        """
        Calculate cosine similarity between two embeddings.

        Args:
            embedding1: First embedding
            embedding2: Second embedding

        Returns:
            Similarity score between -1 and 1 (typically 0-1 for text)
        """
        import numpy as np

        vec1 = np.array(embedding1)
        vec2 = np.array(embedding2)

        dot_product = np.dot(vec1, vec2)
        norm1 = np.linalg.norm(vec1)
        norm2 = np.linalg.norm(vec2)

        if norm1 == 0 or norm2 == 0:
            return 0.0

        return dot_product / (norm1 * norm2)

    async def find_similar_claims(
        self,
        query_embedding: List[float],
        candidate_embeddings: List[List[float]],
        threshold: float = 0.8,
        top_k: int = 10
    ) -> List[tuple]:
        """
        Find most similar claims to query embedding.

        Args:
            query_embedding: Query vector
            candidate_embeddings: List of candidate vectors
            threshold: Minimum similarity threshold
            top_k: Maximum number of results

        Returns:
            List of (index, similarity_score) tuples
        """
        similarities = []

        for i, candidate in enumerate(candidate_embeddings):
            if candidate is None:
                continue

            similarity = self.cosine_similarity(query_embedding, candidate)

            if similarity >= threshold:
                similarities.append((i, similarity))

        # Sort by similarity descending
        similarities.sort(key=lambda x: x[1], reverse=True)

        return similarities[:top_k]


# Global singleton instance
_embedding_service = None


def get_embedding_service() -> EmbeddingService:
    """Get or create singleton embedding service instance."""
    global _embedding_service

    if _embedding_service is None:
        _embedding_service = EmbeddingService()

    return _embedding_service
