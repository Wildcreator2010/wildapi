const axios = require('axios');
const { StringDecoder } = require('string_decoder');
const logger = require('../utils/logger');
const { joinUpstream } = require('../utils/upstreamUrl');

/**
 * 代理转发服务
 * 负责将请求转发到上游 AI 服务商，支持流式 (SSE) 转发与分片累计
 */

const DEFAULT_TIMEOUT = 120000; // 120 秒超时
const MAX_ERROR_BODY_BYTES = 1024 * 1024; // 上游错误体收集上限，防止异常响应打爆内存

// 上游统一使用 OpenAI 兼容方言: 鉴权头一律 Bearer，路径由 upstreamPath 决定。
// provider.type 只决定计价口径，不改变线路协议 (探活与转发必须用同一套请求形状，
// 否则探活报"健康"的模型真实流量却打不通)。
function buildUpstreamHeaders(apiKey, cleanHeaders) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    ...cleanHeaders,
  };
}

/**
 * 从 SSE 数据块提取增量文本 (OpenAI 与 Anthropic 流式结构)
 */
function extractDeltaText(line) {
  if (!line.startsWith('data:')) return '';
  const payload = line.substring(5).trim();
  if (!payload || payload === '[DONE]') return '';
  try {
    const json = JSON.parse(payload);
    // OpenAI: choices[0].delta.content (推理模型的 reasoning_content 与工具调用参数
    // 同样计入输出文本，否则上游不回 usage 时这两类输出会被漏计费)
    const delta = json.choices?.[0]?.delta;
    const toolArgs = Array.isArray(delta?.tool_calls)
      ? delta.tool_calls.map((t) => t.function?.arguments || '').join('')
      : '';
    const piece = (delta?.content || '') + (delta?.reasoning_content || '') + toolArgs;
    if (piece) return piece;
    // Anthropic: content_block_delta.text_delta
    if (json.type === 'content_block_delta' && json.delta?.text) return json.delta.text;
    // Completions: choices[0].text
    if (json.choices?.[0]?.text) return json.choices[0].text;
  } catch {
    // 非 JSON 分片忽略
  }
  return '';
}

/**
 * 从 SSE 数据块提取上游真实 usage
 * OpenAI 需在请求里带 stream_options.include_usage，最后一个分片才回 usage
 */
function extractStreamUsage(line, acc) {
  if (!line.startsWith('data:')) return;
  const payload = line.substring(5).trim();
  if (!payload || payload === '[DONE]') return;
  try {
    const json = JSON.parse(payload);
    if (json.usage) {
      const inTok = json.usage.prompt_tokens ?? json.usage.input_tokens;
      const outTok = json.usage.completion_tokens ?? json.usage.output_tokens;
      if (Number.isFinite(inTok)) acc.promptTokens = inTok;
      if (Number.isFinite(outTok)) acc.completionTokens = outTok;
    }
  } catch {
    // 忽略非 JSON 分片
  }
}

/**
 * 收集上游错误响应体 (流式已建立但状态码非 2xx 时，交由调用方按普通错误处理)
 */
async function collectErrorBody(stream) {
  const decoder = new StringDecoder('utf8');
  let text = '';
  let truncated = false;
  return await new Promise((resolve) => {
    stream.on('data', (chunk) => {
      if (truncated) return;
      text += decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      if (text.length > MAX_ERROR_BODY_BYTES) {
        truncated = true;
        text = text.substring(0, MAX_ERROR_BODY_BYTES);
        stream.destroy();
      }
    });
    stream.on('end', () => resolve(parseMaybeJson(text)));
    stream.on('close', () => resolve(parseMaybeJson(text)));
    stream.on('error', () => resolve(parseMaybeJson(text)));
  });
}

function parseMaybeJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { error: { message: '上游返回错误', type: 'upstream_error' } };
  try {
    return JSON.parse(trimmed);
  } catch {
    return { error: { message: trimmed.substring(0, 500), type: 'upstream_error' } };
  }
}

/**
 * 转发请求到上游
 * @param {string} baseUrl - 上游基础地址
 * @param {string} path - 请求路径
 * @param {string} apiKey - 上游 API 密钥
 * @param {Object} body - 请求体 (透传)
 * @param {Object} headers - 透传的部分请求头
 * @param {Object} options - { isStream, onChunk, upstreamPath, method, query, onStreamOpen, signal }
 *   onStreamOpen(status, headers): 返回 false 表示"不要流式透传" (上游非 2xx)，
 *   此时 forwardRequest 收集 JSON 错误体并按非流式结果返回，调用方可继续重试/切换服务商。
 *   onChunk 返回 Promise 时按背压暂停上游流，drain 后自动恢复。
 * @returns {{ statusCode, headers, body, latencyMs, stream?, isTimeout?, isNetworkError? }}
 */
async function forwardRequest(baseUrl, path, apiKey, body, headers = {}, options = {}) {
  const startTime = Date.now();
  const {
    isStream = false, onChunk = null, upstreamPath = null, method = 'POST',
    query = null, onStreamOpen = null, signal = null,
  } = options;

  const cleanHeaders = {};
  const allowedHeaders = ['content-type', 'accept', 'user-agent'];
  for (const h of allowedHeaders) {
    if (headers[h]) cleanHeaders[h] = headers[h];
  }

  // joinUpstream: 兼容 base_url 自带 /v1 的服务商 (如 dashscope compatible-mode)，避免 /v1/v1 双前缀 404
  const url = joinUpstream(baseUrl, upstreamPath || path, query);

  logger.info('转发请求', { url, method, model: body?.model, isStream });

  const hasBody = method !== 'GET' && method !== 'HEAD';
  const requestConfig = {
    method,
    url,
    headers: buildUpstreamHeaders(apiKey, cleanHeaders),
    data: hasBody ? body : undefined,
    timeout: DEFAULT_TIMEOUT,
    validateStatus: () => true,
  };
  if (signal) requestConfig.signal = signal;

  if (isStream) {
    requestConfig.responseType = 'stream';
  }

  try {
    const response = await axios(requestConfig);

    const latencyMs = Date.now() - startTime;

    if (!isStream) {
      return {
        statusCode: response.status,
        headers: response.headers,
        body: response.data,
        latencyMs,
      };
    }

    // 上游状态码在写出任何分片前即可知: 先让调用方决定协议，
    // 避免 4xx/5xx 错误体被当作 200 SSE 透传给客户端 (旧实现在首个分片才补头，状态码已锁死 200)
    if (typeof onStreamOpen === 'function') {
      let acceptStream = true;
      try {
        acceptStream = onStreamOpen(response.status, response.headers) !== false;
      } catch (err) {
        logger.warn('流式响应头处理异常', { error: err.message });
        acceptStream = false;
      }
      if (!acceptStream) {
        const errBody = await collectErrorBody(response.data);
        return { statusCode: response.status, headers: response.headers, body: errBody, latencyMs };
      }
    }

    // 流式: 透传分片 + 累计文本与 usage (供计费优先取上游真实用量)
    let streamText = '';
    let chunkCount = 0;
    let interrupted = false;
    const usage = { promptTokens: null, completionTokens: null };
    const stream = response.data;
    // 用 StringDecoder 累计解码，避免多字节字符跨分片被截断成乱码 (计费文本与实际输出不一致)
    const decoder = new StringDecoder('utf8');

    const result = {
      statusCode: response.status,
      headers: response.headers,
      body: null,
      latencyMs,
    };

    await new Promise((resolve) => {
      let buffer = '';
      const handleLine = (line) => {
        if (!line) return;
        streamText += extractDeltaText(line);
        extractStreamUsage(line, usage);
      };

      stream.on('data', (chunk) => {
        chunkCount++;
        buffer += decoder.write(chunk);
        // 按行解析 SSE，提取增量文本与 usage
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.substring(0, idx).trim();
          buffer = buffer.substring(idx + 1);
          handleLine(line);
        }
        if (onChunk) {
          const ret = onChunk(chunk);
          // 背压: 客户端写得慢时暂停上游，drain 后恢复，避免内存堆积
          if (ret && typeof ret.then === 'function') {
            stream.pause();
            ret.then(() => stream.resume(), () => stream.resume());
          }
        }
      });
      stream.on('end', () => {
        // 解码器尾部字节 + 残留缓冲
        const tail = buffer + decoder.end();
        if (tail.trim()) handleLine(tail.trim());
        resolve();
      });
      stream.on('close', () => resolve());
      stream.on('error', (e) => {
        interrupted = true;
        logger.warn('流式传输中断', { error: e.message });
        resolve();
      });
    });

    result.stream = { text: streamText, chunkCount, interrupted, usage };
    return result;
  } catch (err) {
    const latencyMs = Date.now() - startTime;

    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      return {
        statusCode: 504,
        headers: {},
        body: { error: { message: '上游服务超时', type: 'upstream_timeout' } },
        latencyMs,
        isTimeout: true,
      };
    }

    // 客户端主动断开 (AbortController): 不计为上游故障
    if (err.code === 'ERR_CANCELED' || err.type === 'aborted' || err.name === 'CanceledError') {
      return {
        statusCode: 499,
        headers: {},
        body: { error: { message: '客户端已断开', type: 'client_aborted' } },
        latencyMs,
        isClientAborted: true,
      };
    }

    return {
      statusCode: err.response?.status || 502,
      headers: err.response?.headers || {},
      body: err.response?.data || { error: { message: err.message, type: 'upstream_error' } },
      latencyMs,
      isNetworkError: !err.response,
    };
  }
}

module.exports = { forwardRequest, extractDeltaText, extractStreamUsage, buildUpstreamHeaders };
