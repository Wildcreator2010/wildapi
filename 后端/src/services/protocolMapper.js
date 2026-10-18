/**
 * 协议映射: Anthropic Messages API ↔ OpenAI Chat Completions
 * 双向透明转换，不改写用户字段，计费口径一致 (token 数不变)
 * 另含 OpenAI Responses API → Chat Completions 映射 (DeepSeek Harness 等新工具兼容)
 */

/**
 * finish_reason (OpenAI) → stop_reason (Anthropic) 完整映射，
 * 不透传非法枚举值 (旧实现把 'length'/'content_filter' 原样透传给客户端)
 */
function mapStopReason(finishReason) {
  switch (finishReason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'content_filter': return 'end_turn';
    default: return 'end_turn';
  }
}

/**
 * Anthropic tool_choice → OpenAI tool_choice
 * Anthropic 用对象: {type:'auto'|'any'|'tool', name?}; OpenAI 用字符串或 function 对象
 */
function mapToolChoice(choice) {
  if (!choice) return undefined;
  if (typeof choice === 'string') {
    return (choice === 'none' || choice === 'auto') ? choice : undefined;
  }
  if (choice.type === 'tool' && choice.name) {
    return { type: 'function', function: { name: choice.name } };
  }
  if (choice.type === 'any') return 'required';
  if (choice.type === 'auto' || choice.type === 'none') return choice.type;
  return undefined;
}

/**
 * Anthropic /v1/messages 请求 → OpenAI chat/completions 请求
 * 工具调用完整双向映射: tools / tool_choice / tool_use / tool_result。
 * 此前 tools 被直接丢弃、tool_use/tool_result 拍平成文本，
 * 结果 Claude SDK 类客户端经 /v1/messages 调用时函数调用整条链路失效。
 */
function anthropicToOpenAI(body) {
  const openai = {};
  const messages = [];

  // system: string 或 blocks 数组
  if (body.system) {
    const sysText = typeof body.system === 'string'
      ? body.system
      : (Array.isArray(body.system) ? body.system.map(b => b.text || '').join('\n') : String(body.system));
    if (sysText) messages.push({ role: 'system', content: sysText });
  }

  // tool_result 块转成 OpenAI 的 role:'tool' 消息
  const pushToolResult = (block) => {
    const id = block.tool_use_id;
    if (!id) return;
    let content = '';
    if (typeof block.content === 'string') content = block.content;
    else if (Array.isArray(block.content)) {
      content = block.content.map(b => (b && b.type === 'text' ? (b.text || '') : '')).join('');
    } else if (block.content != null) content = JSON.stringify(block.content);
    if (block.is_error) content = `[tool error] ${content}`;
    messages.push({ role: 'tool', tool_call_id: id, content });
  };

  for (const m of body.messages || []) {
    const role = m.role;
    if (typeof m.content === 'string') {
      messages.push({ role, content: m.content });
      continue;
    }
    if (Array.isArray(m.content)) {
      // assistant 历史里的 tool_use 块 → tool_calls (OpenAI 要求放在同一条 assistant 消息上)
      const toolCalls = [];
      const parts = [];
      let hasImage = false;
      let hasToolResult = false;

      for (const b of m.content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') {
          parts.push({ type: 'text', text: b.text || '' });
        } else if (b.type === 'image') {
          hasImage = true;
          const src = b.source || {};
          if (src.type === 'base64' && src.data) {
            parts.push({ type: 'image_url', image_url: { url: `data:${src.media_type || 'image/png'};base64,${src.data}` } });
          } else if (src.type === 'url' && src.url) {
            parts.push({ type: 'image_url', image_url: { url: src.url } });
          }
        } else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id || `call_${toolCalls.length}`,
            type: 'function',
            function: { name: b.name || '', arguments: JSON.stringify(b.input ?? {}) },
          });
        } else if (b.type === 'tool_result') {
          hasToolResult = true;
          pushToolResult(b);
        } else {
          parts.push({ type: 'text', text: b.text || '' });
        }
      }

      // tool_result 一般出现在 user 消息里，已单独 push 为 role:'tool'
      if (hasToolResult && toolCalls.length === 0 && parts.length === 0) continue;

      const text = parts.filter(p => p.type === 'text').map(p => p.text).join('');
      if (toolCalls.length > 0) {
        // OpenAI: content 与 tool_calls 可共存，但纯工具调用时给空串更兼容
        messages.push({ role: 'assistant', content: text || '', tool_calls: toolCalls });
        continue;
      }
      if (!hasImage) {
        messages.push({ role, content: text });
      } else {
        messages.push({ role, content: parts });
      }
      continue;
    }
    messages.push({ role, content: '' });
  }

  openai.messages = messages;
  openai.max_tokens = body.max_tokens;

  // 工具定义: input_schema → function.parameters
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    openai.tools = body.tools
      .filter(t => t && t.name)
      .map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.input_schema || { type: 'object', properties: {} },
        },
      }));
    if (openai.tools.length === 0) delete openai.tools;
  }
  const toolChoice = mapToolChoice(body.tool_choice);
  if (toolChoice !== undefined) openai.tool_choice = toolChoice;

  // 透传通用参数 (top_k / thinking 属上游方言差异，官方 OpenAI 会拒绝未知字段，故不转发)
  for (const k of ['temperature', 'top_p', 'stop_sequences', 'stream', 'metadata']) {
    if (body[k] !== undefined) openai[k] = body[k];
  }
  if (body.stop_sequences) openai.stop = body.stop_sequences;
  delete openai.stop_sequences;

  return openai;
}

/**
 * OpenAI chat 完成响应 → Anthropic Messages 响应 (非流式)
 * tool_calls 还原成 tool_use 内容块，stop_reason 相应给出 tool_use
 */
function openAIToAnthropic(openaiBody, openaiRes, model, requestBody) {
  const choice = openaiRes.choices?.[0];
  const usage = openaiRes.usage || {};
  const text = choice?.message?.content || choice?.text || '';
  const toolCalls = Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : [];

  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const [i, tc] of toolCalls.entries()) {
    let input = {};
    const raw = tc.function?.arguments;
    if (raw) {
      try {
        input = JSON.parse(raw);
      } catch {
        // 上游给出非法 JSON 参数时不能丢工具调用本身，包一层交给客户端判断
        input = { __raw_arguments: raw };
      }
    }
    content.push({
      type: 'tool_use',
      id: tc.id || `toolu_${Date.now()}_${i}`,
      name: tc.function?.name || '',
      input,
    });
  }

  return {
    id: openaiRes.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: model || openaiRes.model,
    content,
    stop_reason: toolCalls.length > 0 ? 'tool_use' : mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  };
}

/**
 * OpenAI 流式分片 → Anthropic 流式事件 (SSE 文本行，供透传)
 * 严格遵循 Anthropic SSE 序列:
 * message_start → (content_block_start → deltas* → content_block_stop)* →
 * message_delta → message_stop
 *
 * 内容块按出现顺序编号，支持 文本 / 思考(reasoning_content) / 工具调用参数增量
 * 混排 (旧实现只有单一 index 0 文本块，工具调用被整段丢掉)。
 */
function createAnthropicStreamTransformer(model, openaiBody) {
  let started = false;
  let blockIndex = 0;
  let openBlock = null;        // { index, kind, toolIndex }
  let hasToolUse = false;
  let inputTokens = 0;
  let outputTokens = 0;
  const toolBlocks = new Map(); // 上游 tool_calls[i].index → Anthropic 内容块 index

  const closeOpen = (out) => {
    if (!openBlock) return;
    out.push({ type: 'content_block_stop', index: openBlock.index });
    openBlock = null;
  };

  const ensureMessageStart = (out, json) => {
    if (started) return;
    started = true;
    out.push({
      type: 'message_start',
      message: {
        id: json?.id || `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: model || json?.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };

  const openBlockOf = (out, kind) => {
    if (openBlock && openBlock.kind === kind && kind !== 'tool') return;
    closeOpen(out);
    const index = blockIndex++;
    const contentBlock = kind === 'thinking'
      ? { type: 'thinking', thinking: '' }
      : { type: 'text', text: '' };
    out.push({ type: 'content_block_start', index, content_block: contentBlock });
    openBlock = { index, kind };
  };

  const openToolBlock = (out, tc) => {
    const key = tc.index ?? 0;
    if (toolBlocks.has(key)) {
      // 同一把工具的后续参数分片: 若不是当前打开的块则切回去 (混排极少，稳妥处理)
      const index = toolBlocks.get(key);
      if (openBlock && openBlock.index === index) return;
      closeOpen(out);
      out.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: tc.id || '', name: tc.function?.name || '', input: {} } });
      openBlock = { index, kind: 'tool', toolIndex: key };
      return;
    }
    closeOpen(out);
    const index = blockIndex++;
    toolBlocks.set(key, index);
    hasToolUse = true;
    out.push({
      type: 'content_block_start',
      index,
      content_block: {
        type: 'tool_use',
        id: tc.id || `toolu_${Date.now()}_${index}`,
        name: tc.function?.name || '',
        input: {},
      },
    });
    openBlock = { index, kind: 'tool', toolIndex: key };
  };

  return function transform(line) {
    if (!line.startsWith('data:')) return null;
    const payload = line.substring(5).trim();
    if (!payload) return null;

    if (payload === '[DONE]') {
      const out = [];
      closeOpen(out);
      out.push({ type: 'message_stop' });
      started = false;
      return out.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
    }

    try {
      const json = JSON.parse(payload);
      if (json.usage) {
        inputTokens = json.usage.prompt_tokens || inputTokens;
        outputTokens = json.usage.completion_tokens || outputTokens;
      }

      const choice = json.choices?.[0] || {};
      const delta = choice.delta || {};
      const text = delta.content || choice.text || '';
      const reasoning = delta.reasoning_content || '';
      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      const events = [];

      ensureMessageStart(events, json);

      if (reasoning) {
        openBlockOf(events, 'thinking');
        events.push({ type: 'content_block_delta', index: openBlock.index, delta: { type: 'thinking_delta', thinking: reasoning } });
      }
      if (text) {
        openBlockOf(events, 'text');
        events.push({ type: 'content_block_delta', index: openBlock.index, delta: { type: 'text_delta', text } });
      }
      for (const tc of toolCalls) {
        const args = tc.function?.arguments || '';
        if (!tc.id && !tc.function?.name && !args) continue;
        openToolBlock(events, tc);
        if (args) {
          events.push({ type: 'content_block_delta', index: openBlock.index, delta: { type: 'input_json_delta', partial_json: args } });
        }
      }

      // 最后一块带 finish_reason: 关闭内容块并发出 message_delta
      if (choice.finish_reason) {
        closeOpen(events);
        events.push({
          type: 'message_delta',
          delta: {
            stop_reason: choice.finish_reason === 'tool_calls' || hasToolUse ? 'tool_use' : mapStopReason(choice.finish_reason),
            stop_sequence: null,
          },
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        });
      }

      return events.length ? events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') : null;
    } catch {
      return null;
    }
  };
}

module.exports = { anthropicToOpenAI, openAIToAnthropic, createAnthropicStreamTransformer, responsesToOpenAI, openAIToResponses, createResponsesStreamTransformer };

// ==================== OpenAI Responses API ↔ Chat Completions ====================
// Responses API 是 OpenAI 新协议 (DeepSeek Harness / Codex 等工具使用)，
// 上游不支持时在此层转换为 Chat Completions，token 计数不变，计费口径一致。
// 支持范围: 文本对话 (input 字符串/消息数组)，工具调用等高级特性不在转换范围。

/**
 * 从 input item 提取文本 (兼容多种内容格式)
 */
function extractItemText(item) {
  if (!item) return '';
  if (typeof item === 'string') return item;
  const content = item.content !== undefined ? item.content : item.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(c => c.text || c.input_text || '')
      .join('');
  }
  return '';
}

/**
 * Responses API 请求 → Chat Completions 请求 (仅提取 model，其余参数由调用方合并)
 */
function responsesToOpenAI(body) {
  const messages = [];
  const input = body.input;

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    // input items: message / 扁平 content 项 (role 可能在 item 上，也可能逐条平铺)
    let currentRole = null;
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'message' || item.role) {
        const role = item.role || 'user';
        currentRole = role;
        const text = extractItemText(item);
        if (text) messages.push({ role, content: text });
      } else if (item.type === 'item_reference') {
        continue; // 历史引用，无法在中转层还原，跳过
      } else {
        // 无 type 的内容项，归入最近一个 role (默认 user)
        const text = extractItemText(item);
        if (text) messages.push({ role: currentRole || item.role || 'user', content: text });
      }
    }
    if (messages.length === 0 && input.length > 0) {
      // 全部无法解析时兜底: 拼接为单条 user 消息
      messages.push({ role: 'user', content: input.map(extractItemText).filter(Boolean).join('\n') });
    }
  }

  if (messages.length === 0) messages.push({ role: 'user', content: '' });

  // Responses 参数 → Chat Completions 参数
  const openai = { messages };
  if (body.max_output_tokens !== undefined) openai.max_tokens = body.max_output_tokens;
  if (body.instructions) messages.unshift({ role: 'system', content: body.instructions });
  for (const k of ['temperature', 'top_p', 'stream', 'metadata', 'user', 'stop', 'seed', 'presence_penalty', 'frequency_penalty']) {
    if (body[k] !== undefined) openai[k] = body[k];
  }
  if (body.reasoning?.effort && body.model && body.model.includes('reasoning')) {
    // reasoning 模型不在中转范围，忽略即可 (不透传未知字段避免上游报错)
  }
  return openai;
}

/**
 * Chat Completions 响应 → Responses API 响应 (非流式)
 */
function openAIToResponses(openaiRes, model) {
  const choice = openaiRes.choices?.[0];
  const text = choice?.message?.content || choice?.text || '';
  const usage = openaiRes.usage || {};
  const status = choice?.finish_reason === 'stop' || !choice?.finish_reason ? 'completed' : 'incomplete';
  return {
    id: openaiRes.id ? openaiRes.id.replace('chatcmpl-', 'resp_') : `resp_${Date.now()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: model || openaiRes.model,
    output: [{
      id: `msg_${Date.now()}`,
      type: 'message',
      status,
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    }],
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)),
    },
    metadata: openaiRes.metadata || {},
  };
}

/**
 * Chat Completions 流式分片 → Responses API 流式事件 (SSE 行)
 * 状态机: response.created → output_item.added → response.output_text.delta* →
 *          response.output_text.done → output_item.done → response.completed
 */
function createResponsesStreamTransformer(model) {
  let started = false;
  let accumulated = '';
  const respId = `resp_${Date.now()}`;
  const msgId = `msg_${Date.now()}`;

  const baseResponse = (status) => ({
    id: respId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: [],
    usage: null,
    metadata: {},
  });

  const emit = (events) => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');

  return function transform(line) {
    if (!line.startsWith('data:')) return null;
    const payload = line.substring(5).trim();
    if (!payload) return null;

    if (payload === '[DONE]') {
      // 兜底终结: 若上游未发 finish_reason，也确保发出终结事件 (Harness 要求)
      const events = [];
      if (started) {
        events.push(
          { type: 'response.output_text.done', text: accumulated },
          {
            type: 'output_item.done',
            item: {
              id: msgId, type: 'message', status: 'completed', role: 'assistant',
              content: [{ type: 'output_text', text: accumulated, annotations: [] }],
            },
          },
          { type: 'response.completed', response: { ...baseResponse('completed'), output: [{ id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: accumulated, annotations: [] }] }] } },
        );
        started = false;
      }
      return events.length ? emit(events) : null;
    }

    try {
      const json = JSON.parse(payload);
      const events = [];

      if (!started) {
        started = true;
        events.push(
          { type: 'response.created', response: baseResponse('in_progress') },
          {
            type: 'output_item.added',
            item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
          },
          { type: 'response.content_part.added', item_id: msgId, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        );
      }

      const delta = json.choices?.[0]?.delta?.content || json.choices?.[0]?.text || '';
      if (delta) {
        accumulated += delta;
        events.push({ type: 'response.output_text.delta', item_id: msgId, content_index: 0, delta });
      }

      // finish_reason 出现: 发完整终结序列 (后续 [DONE] 不会重复发)
      if (json.choices?.[0]?.finish_reason) {
        const usage = json.usage;
        const resp = {
          ...baseResponse('completed'),
          output: [{
            id: msgId, type: 'message', status: 'completed', role: 'assistant',
            content: [{ type: 'output_text', text: accumulated, annotations: [] }],
          }],
          usage: usage ? {
            input_tokens: usage.prompt_tokens || 0,
            output_tokens: usage.completion_tokens || 0,
            total_tokens: usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)),
          } : null,
        };
        events.push(
          { type: 'response.output_text.done', text: accumulated },
          {
            type: 'output_item.done',
            item: resp.output[0],
          },
          { type: 'response.completed', response: resp },
        );
        started = false;
      }

      return events.length ? emit(events) : null;
    } catch {
      return null;
    }
  };
}
