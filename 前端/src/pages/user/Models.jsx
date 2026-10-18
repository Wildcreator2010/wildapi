import { useState, useEffect } from 'react';
import api from '../../services/api';
import { toast } from '../../components/ui/Toast';

const PROVIDER_LABELS = {
  openai: 'OpenAI',
  azure: 'Azure OpenAI',
  anthropic: 'Claude',
  gemini: 'Gemini',
  custom: '自定义',
};

export default function Models() {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);

  const origin = window.location.origin;
  // 本地路由兜底时 model 是匹配模式 (如 gpt-4*)，直接抄进 curl 示例会调用失败
  const sampleModel = (models[0]?.model || '').replace(/\*/g, '') || 'gpt-4o';

  const openaiCurl = `curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer <你的代理Key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${sampleModel}",
    "messages": [{"role": "user", "content": "你好"}]
  }'`;

  const anthropicCurl = `curl ${origin}/v1/messages \\
  -H "x-api-key: <你的代理Key>" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${sampleModel}",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "你好"}]
  }'`;

  useEffect(() => {
    api.get('/user/models')
      .then(r => setModels(r.data.data.list))
      .catch((err) => toast(err.response?.data?.error?.message || '加载失败', 'error'))
      .finally(() => setLoading(false));
  }, []);

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制到剪贴板');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      toast('已复制到剪贴板');
    }
  };

  return (
    <div>
      <h2 className="text-2xl font-bold text-slate-800 mb-2">模型列表</h2>
      <p className="text-sm text-slate-500 mb-6">
        以下为当前可调用的模型（优先展示上游实时检测可用的模型，并自动同步更新）。
        在「API 密钥」页创建代理 Key 后即可调用。
      </p>

      {/* 模型清单 */}
      <div className="bg-white rounded-xl shadow-sm border overflow-hidden mb-8">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-3">模型代号</th>
              <th className="text-left px-4 py-3">厂商</th>
              <th className="text-left px-4 py-3">支持协议</th>
              <th className="text-left px-4 py-3">状态</th>
            </tr>
          </thead>
          <tbody>
            {models.map(m => (
              <tr key={`${m.providerId || m.providerName}-${m.model}`} className="border-t">
                <td className="px-4 py-3 font-mono text-xs">
                  {m.hasWildcard ? (
                    <span>
                      {m.model}
                      <span className="ml-2 text-xs text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">前缀匹配</span>
                    </span>
                  ) : m.model}
                </td>
                <td className="px-4 py-3">
                  <span className="bg-slate-100 px-2 py-0.5 rounded text-xs">
                    {PROVIDER_LABELS[m.providerType] || m.providerType}
                  </span>
                  <span className="ml-2 text-xs text-slate-400">{m.providerName}</span>
                </td>
                <td className="px-4 py-3">
                  {m.protocols.map(p => (
                    <code key={p} className="mr-2 bg-gray-50 border rounded px-1.5 py-0.5 text-xs font-mono">{p}</code>
                  ))}
                </td>
                <td className="px-4 py-3">
                  <span className="px-2 py-0.5 rounded text-xs bg-emerald-100 text-emerald-700">
                    {m.source === 'upstream' ? '可用' : '上架'}
                  </span>
                </td>
              </tr>
            ))}
            {!loading && models.length === 0 && (
              <tr><td colSpan="4" className="text-center py-8 text-slate-400">暂无上架模型</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 调用指引 */}
      <h3 className="font-semibold text-lg mb-4">调用指引</h3>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* OpenAI 格式 */}
        <div className="bg-white rounded-xl shadow-sm border p-5">
          <div className="flex items-center justify-between mb-3">
            <h4 className="font-semibold">OpenAI 格式</h4>
            <button onClick={() => copy(openaiCurl)} className="text-xs px-3 py-1 bg-primary-600 text-white rounded-lg hover:bg-primary-700">复制</button>
          </div>
          <p className="text-sm text-slate-500 mb-3">
            请求地址: <code className="bg-gray-50 px-1 rounded">{origin}/v1/chat/completions</code>
            <br />认证: <code className="bg-gray-50 px-1 rounded">Authorization: Bearer &lt;你的代理Key&gt;</code>
          </p>
          <pre className="bg-gray-900 text-gray-100 rounded-lg p-4 text-xs overflow-auto max-h-56">{openaiCurl}</pre>
          <div className="mt-3 text-xs text-slate-500 space-y-1">
            <p><strong>关键参数:</strong></p>
            <p>· <code>model</code> (必填) - 上表中的模型代号</p>
            <p>· <code>messages</code> (必填) - [{'{'}role: system|user|assistant, content: string{'}'}]</p>
            <p>· <code>stream</code> (可选) - true 时返回 SSE 流式响应</p>
            <p>· <code>temperature</code> / <code>max_tokens</code> (可选) - 生成参数</p>
          </div>
        </div>

        {/* Anthropic 格式 */}
        <div className="bg-white rounded-xl shadow-sm border p-5">
          <div className="flex items-center justify-between mb-3">
            <h4 className="font-semibold">Anthropic 格式</h4>
            <button onClick={() => copy(anthropicCurl)} className="text-xs px-3 py-1 bg-primary-600 text-white rounded-lg hover:bg-primary-700">复制</button>
          </div>
          <p className="text-sm text-slate-500 mb-3">
            请求地址: <code className="bg-gray-50 px-1 rounded">{origin}/v1/messages</code>
            <br />认证: <code className="bg-gray-50 px-1 rounded">x-api-key: &lt;你的代理Key&gt;</code> + <code className="bg-gray-50 px-1 rounded">anthropic-version: 2023-06-01</code>
          </p>
          <pre className="bg-gray-900 text-gray-100 rounded-lg p-4 text-xs overflow-auto max-h-56">{anthropicCurl}</pre>
          <div className="mt-3 text-xs text-slate-500 space-y-1">
            <p><strong>关键参数:</strong></p>
            <p>· <code>model</code> (必填) - 上表中的模型代号</p>
            <p>· <code>messages</code> (必填) - [{'{'}role: user|assistant, content: string{'}'}]</p>
            <p>· <code>max_tokens</code> (必填) - 最大输出 token 数</p>
            <p>· <code>system</code> (可选) - 系统提示词</p>
          </div>
        </div>
      </div>

      <div className="mt-6 p-4 bg-blue-50 border border-blue-100 rounded-lg text-sm text-blue-800">
        提示：Claude 厂商的模型建议使用 Anthropic 格式调用；所有模型均兼容 OpenAI 格式。
        代理 Key 在「API 密钥」页面创建，明文仅显示一次，请妥善保存。
      </div>
    </div>
  );
}
