/**
 * Token 用量估算器
 * 优先使用上游返回的 usage 字段，否则用 tiktoken 近似估算
 */
let tiktokenEncoder = null;

async function getEncoder() {
  if (!tiktokenEncoder) {
    try {
      const { get_encoding } = require('tiktoken');
      tiktokenEncoder = get_encoding('cl100k_base');
    } catch (e) {
      // tiktoken 不可用时降级为字符估算
      tiktokenEncoder = null;
    }
  }
  return tiktokenEncoder;
}

/**
 * 估算文本的 token 数量
 * @param {string} text
 * @returns {number}
 */
async function estimateTokens(text) {
  if (!text) return 0;

  const encoder = await getEncoder();
  if (encoder) {
    try {
      return encoder.encode(text).length;
    } catch {
      // 降级
    }
  }

  // 降级估算: 中文约 1.5 字符/token，英文约 4 字符/token
  let tokens = 0;
  for (const char of text) {
    if (/[\u4e00-\u9fff]/.test(char)) {
      tokens += 1 / 1.5;
    } else {
      tokens += 1 / 4;
    }
  }
  return Math.ceil(tokens);
}

/**
 * 从消息数组中提取文本
 */
function extractMessagesText(messages) {
  if (!Array.isArray(messages)) return JSON.stringify(messages || {});
  return messages.map(m => {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map(c => (c.text || '')).join(' ');
    }
    return '';
  }).join('\n');
}

/**
 * 从请求体估算输入 token 数
 */
async function estimateInputTokens(requestBody) {
  const text = requestBody.messages
    ? extractMessagesText(requestBody.messages)
    : requestBody.prompt
    ? (typeof requestBody.prompt === 'string' ? requestBody.prompt : JSON.stringify(requestBody.prompt))
    : JSON.stringify(requestBody);

  return estimateTokens(text);
}

/**
 * 提取实际 token 用量
 * 优先从 OpenAI 标准 usage 字段获取，否则估算
 */
async function getTokenUsage(responseBody, requestBody) {
  // 优先取 upstream 返回的实际用量
  if (responseBody?.usage) {
    return {
      tokensIn: responseBody.usage.prompt_tokens || 0,
      tokensOut: responseBody.usage.completion_tokens || 0,
      isEstimated: false,
    };
  }

  // 从 choices 长度估算输出 token
  const outputText = responseBody?.choices
    ? responseBody.choices.map(c => {
        if (c.message?.content) return c.message.content;
        if (c.text) return c.text;
        return '';
      }).join('')
    : '';

  const [tokensIn, tokensOut] = await Promise.all([
    estimateInputTokens(requestBody),
    estimateTokens(outputText),
  ]);

  return { tokensIn, tokensOut, isEstimated: true };
}

module.exports = { estimateInputTokens, estimateTokens, getTokenUsage };
