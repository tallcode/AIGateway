import type { Adapter, ModelConfig } from '../types.js'
import { asRecord, clampBudgetTokens, dropContentBlockTypes } from './shared.js'

// Content block types the DeepSeek Anthropic endpoint does not understand.
// Includes Claude's native server-tool blocks (server_tool_use /
// web_search_tool_result / code_execution_tool_result): Claude Code sends
// these in history whenever web search or code execution was used, and the
// trio is confirmed as one family by rig (anthropic/completion.rs).
// `thinking` (plain or encrypted) is dropped too: DeepSeek only accepts its
// own reasoning blocks in history, and rust-genai skips reasoning content
// entirely when building Anthropic requests.
const UNSUPPORTED_BLOCK_TYPES = new Set([
  'thinking',
  'document',
  'search_result',
  'redacted_thinking',
  'code_execution_tool_result',
  'server_tool_use',
  'web_search_tool_result',
  'web_search_tool_result_error',
  'mcp_tool_use',
  'mcp_tool_result',
  'container_upload',
])

// Older DeepSeek models also reject images.
const TEXT_ONLY_BLOCK_TYPES = new Set([...UNSUPPORTED_BLOCK_TYPES, 'image'])

/** Whether the model accepts image content, derived from `architecture.modality`. */
function acceptsImages(model: ModelConfig): boolean {
  const modality = model.architecture?.modality
  return typeof modality === 'string' && modality.includes('image')
}

/**
 * Anthropic requires `tool_use.input` to be an object, never null (see
 * rust-genai adapter_shared.rs). Streaming parsers and cross-SDK histories can
 * produce null; normalize to `{}` so the upstream does not reject the request.
 */
function fixToolUseInputs(payload: Record<string, unknown>): boolean {
  const messages = payload.messages
  if (!Array.isArray(messages))
    return false

  let changed = false
  for (const raw of messages) {
    const message = asRecord(raw)
    const content = message && Array.isArray(message.content) ? message.content : undefined
    if (!content)
      continue
    for (const rawBlock of content) {
      const block = asRecord(rawBlock)
      if (block && block.type === 'tool_use') {
        const input = asRecord(block.input)
        if (!input) {
          block.input = {}
          changed = true
        }
      }
    }
  }
  return changed
}

/**
 * DeepSeek Anthropic adapter. Clamps the thinking budget, strips content
 * blocks the endpoint does not understand, and normalizes `tool_use.input`.
 * Images are dropped only when the model's `architecture.modality` does not
 * advertise image support, so a single adapter serves both text-only and
 * vision models.
 */
export const deepseekAnthropic: Adapter = {
  name: 'deepseek-anthropic',
  protocol: 'anthropic',
  apply(payload, model) {
    const clamped = clampBudgetTokens(payload, 0, 260000)
    const dropped = dropContentBlockTypes(payload, acceptsImages(model) ? UNSUPPORTED_BLOCK_TYPES : TEXT_ONLY_BLOCK_TYPES)
    const fixedInputs = fixToolUseInputs(payload)
    return clamped || dropped || fixedInputs
  },
}

// ---------------------------------------------------------------------------
// DeepSeek OpenAI (chat completions) adapter.
//
// Quirks of the DeepSeek native OpenAI API, mirrored from rig's deepseek
// provider (`finalize_request_body`):
//
// 1. `content` must be a plain string, not an array of parts. Text-only arrays
//    are flattened (user turns joined with "\n", assistant turns with ""); an
//    array carrying an image/audio/video/file part is left alone so DeepSeek's
//    own rejection reaches the caller instead of silently dropping content.
// 2. Assistant turns must always carry a `content` field. Tool-call-only turns
//    sent by OpenAI-style clients use `content: null` or omit the field
//    entirely; DeepSeek wants an empty string, so both become `""`.
// 3. Assistant `tool_calls` entries must carry an `index`; fill in 0.
// 4. Forced tool choices (`tool_choice: "required"` or a specific function)
//    are rejected while thinking is enabled; suppress them to an explicit
//    `null` unless the request explicitly disables thinking.
// ---------------------------------------------------------------------------

/** The textual payload of an OpenAI content part (`text`, or `refusal`). */
function partText(part: Record<string, unknown>): string | undefined {
  if (typeof part.text === 'string')
    return part.text
  return typeof part.refusal === 'string' ? part.refusal : undefined
}

/** True when every part of the content array is plain text (or refusal). */
function isTextOnly(parts: unknown[]): boolean {
  for (const part of parts) {
    const record = asRecord(part)
    if (!record || partText(record) === undefined)
      return false
  }
  return true
}

function thinkingIsDisabled(payload: Record<string, unknown>): boolean {
  const type = asRecord(payload.thinking)?.type
  return typeof type === 'string' && type.toLowerCase() === 'disabled'
}

export const deepseekOpenAI: Adapter = {
  name: 'deepseek-openai',
  protocol: 'openai',
  apply(payload) {
    let changed = false

    const messages = payload.messages
    if (Array.isArray(messages)) {
      for (const raw of messages) {
        const message = asRecord(raw)
        if (!message)
          continue
        const isAssistant = message.role === 'assistant'

        if (Object.hasOwn(message, 'content')) {
          if (Array.isArray(message.content)) {
            if (isTextOnly(message.content)) {
              const flattened = message.content
                .map(part => partText(asRecord(part)!))
                .filter((text): text is string => text !== undefined)
                .join(isAssistant ? '' : '\n')
              message.content = flattened
              changed = true
            }
          }
          else if (isAssistant && message.content === null) {
            // OpenAI-style clients send `content: null` for tool-call-only
            // assistant turns; DeepSeek requires a string.
            message.content = ''
            changed = true
          }
        }
        else if (isAssistant) {
          message.content = ''
          changed = true
        }

        if (isAssistant && Array.isArray(message.tool_calls)) {
          for (const rawCall of message.tool_calls) {
            const call = asRecord(rawCall)
            if (call && !Object.hasOwn(call, 'index')) {
              call.index = 0
              changed = true
            }
          }
        }
      }
    }

    if (!thinkingIsDisabled(payload) && Object.hasOwn(payload, 'tool_choice')) {
      const choice = payload.tool_choice
      const forced = (typeof choice === 'object' && choice !== null) || choice === 'required'
      if (forced) {
        payload.tool_choice = null
        changed = true
      }
    }

    // DeepSeek's native field is `max_tokens`; newer OpenAI SDKs send
    // `max_completion_tokens` instead. Rename when `max_tokens` is absent
    // (mirrors rust-genai's per-model-family field selection).
    if (!Object.hasOwn(payload, 'max_tokens') && typeof payload.max_completion_tokens === 'number') {
      payload.max_tokens = payload.max_completion_tokens
      delete payload.max_completion_tokens
      changed = true
    }

    return changed
  },
}
