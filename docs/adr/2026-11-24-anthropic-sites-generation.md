# Direct Anthropic generation on Sites

**Date** 2026-11-24

**Status** Implemented in source. Hosted activation requires configuration and acceptance.

## Context

The Sites release already separates Soniox transcription from map generation through Gemini or OpenRouter. The owner requested direct Anthropic support for map generation. An OpenRouter key and an Anthropic key configure different recipients and require different consent.

## Decision

Add an opt-in Claude route using Anthropic's Messages API. The Sites Worker holds the workspace-scoped key, selects the configured model, sends finalized utterance text and IDs with a transcript completeness flag, and requests structured JSON. Claude receives the existing map prompt and a compatible version of the graph schema. Anthropic's structured outputs omit the arc array's `maxItems` constraint. LCT still enforces arc parent rules and validates map structure and evidence before producing a portable `.threads` artifact.

The existing D1 ledger and limits govern all three providers. Provider changes require fresh consent. Refusals, incomplete responses and validation failures keep the attempt counted. Claude sends a single generation request to the configured model. The owner selects the model and confirms the Anthropic workspace budget during activation.

## Consequences

The same recording and import entry points can use Claude. Adding the secret by itself leaves the route inactive. A model metadata check confirms reported capability and availability. A synthetic hosted generation is still needed to establish live acceptance for the approved model and workspace.

[Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create) · [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

## 2026-11-24 amendment — Compact Claude schema

A live synthetic control passed and the production schema returned HTTP 400
(`req_011ChMowDExSu9dPthGPmMbz`). Anthropic's public Python SDK schema transformer
rejected the previous wire schema at the array-valued `thread_id.type`.
The Claude schema now represents nullability with explicit `anyOf` and uses a
single node definition. The existing graph validator enforces tier/type
pairing, higher-tier parents, and evidence links. The revised wire schema
passes the public SDK transformer offline. A separate map-only diagnostic
uses the same production payload and one upstream request.
