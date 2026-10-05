# Spelling and Grammar Changelog

## [OpenAI-compatible provider] - 2026-10-05

- Add an OpenAI-compatible provider, with OpenRouter as the default base URL and `openai/gpt-4o` as the default model.
- Accept a full `/chat/completions` endpoint or a base URL with a query string in the base URL setting.
- Show an error, not a partial correction, when the provider fails during the response.
- Hide the paste and copy actions when the correction failed.
- Explain a 404 as a model or URL problem, and shorten long error pages.

## [Initial Version] - 2026-08-03

- Fix spelling and grammar in the selected text with your own Anthropic or OpenAI API key. Thanks @flash286.
