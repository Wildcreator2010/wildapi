/**
 * 上游 URL 拼接归一化
 * 兼容服务商 base_url 两种填写习惯：不带 /v1（如 https://api.deepseek.com）
 * 与自带 /v1（如 https://dashscope-intl.aliyuncs.com/compatible-mode/v1）。
 * 未处理时会产生 /v1/v1/... 双前缀导致上游 404（qwen-global 检测全失效的根因）。
 *
 * base_url 自带查询串（如 Azure 的 ?api-version=2024-02-15-preview）时必须先摘出来，
 * 否则会拼出 /openai?api-version=xxx/v1/chat/completions 这种坏地址。
 */
function joinUpstream(baseUrl, apiPath, query = null) {
  let base = String(baseUrl || '').trim().replace(/\/+$/, '');
  let search = '';
  const qIdx = base.indexOf('?');
  if (qIdx >= 0) {
    search = base.substring(qIdx + 1);
    base = base.substring(0, qIdx);
  }

  const path = String(apiPath || '');
  const joined = (base.endsWith('/v1') && path.startsWith('/v1/'))
    ? base + path.substring(3)
    : base + path;

  const params = new URLSearchParams(search);
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || params.has(key)) continue;
      params.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
  }

  const qs = params.toString();
  return qs ? `${joined}?${qs}` : joined;
}

module.exports = { joinUpstream };
