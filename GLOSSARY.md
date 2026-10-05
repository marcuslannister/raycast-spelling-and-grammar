# Spelling and Grammar

A Raycast command that proofreads the selected text with an AI service that the user pays for directly, then pastes the correction back.

## Language

**Provider**:
The AI service that receives the correction request. The user picks exactly one in the preferences: Anthropic, OpenAI, or an OpenAI-compatible provider.
_Avoid_: Vendor, backend, API

**OpenAI-compatible provider**:
A provider at a URL that the user supplies, which accepts requests in OpenAI's chat-completions format. OpenRouter is the reference example.
_Avoid_: Custom provider, OpenRouter provider, proxy
