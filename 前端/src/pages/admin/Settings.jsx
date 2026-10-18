import { useState, useEffect } from 'react';
import api from '../../services/api';
import { toast } from '../../components/ui/Toast';

export default function Settings() {
  const [settings, setSettings] = useState({});
  const [form, setForm] = useState({});

  useEffect(() => {
    api.get('/admin/settings').then(r => {
      setSettings(r.data.data);
      setForm({ ...r.data.data.settings });
    }).catch(err => toast(err.response?.data?.error?.message || '设置加载失败', 'error'));
  }, []);

  const handleSave = async () => {
    try {
      await api.put('/admin/settings', {
        globalRateLimit: form.globalRateLimit,
        defaultRetryAttempts: form.defaultRetryAttempts,
        defaultRetryDelayMs: form.defaultRetryDelayMs,
        requestBodyMaxSizeMb: form.requestBodyMaxSizeMb,
      });
      toast('设置已保存');
    } catch (err) { toast(err.response?.data?.error?.message || '保存失败', 'error'); }
  };

  return (
    <div>
      <h2 className="text-2xl font-bold text-slate-800 mb-6">系统设置</h2>

      <div className="bg-white rounded-xl shadow-sm border p-6 max-w-2xl space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">全局速率限制 (请求/分钟/IP)</label>
          <input className="w-full border rounded-lg px-3 py-2" value={form.globalRateLimit || ''} onChange={e => setForm({...form, globalRateLimit: e.target.value})} />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">默认重试次数</label>
          <input className="w-full border rounded-lg px-3 py-2" value={form.defaultRetryAttempts || ''} onChange={e => setForm({...form, defaultRetryAttempts: e.target.value})} />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">默认重试延迟 (毫秒)</label>
          <input className="w-full border rounded-lg px-3 py-2" value={form.defaultRetryDelayMs || ''} onChange={e => setForm({...form, defaultRetryDelayMs: e.target.value})} />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">请求体最大大小 (MB)</label>
          <input className="w-full border rounded-lg px-3 py-2" value={form.requestBodyMaxSizeMb || ''} onChange={e => setForm({...form, requestBodyMaxSizeMb: e.target.value})} />
        </div>
        <button onClick={handleSave} className="px-6 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700">保存设置</button>
      </div>

      {settings.pricing && (
        <div className="mt-8">
          <h3 className="font-semibold text-lg mb-4">模型定价配置</h3>
          <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr><th className="px-4 py-2 text-left">模型</th><th className="px-4 py-2 text-left">输入价格 ($/1K)</th><th className="px-4 py-2 text-left">输出价格 ($/1K)</th></tr>
              </thead>
              <tbody>
                {Object.entries(settings.pricing).map(([model, price]) => (
                  <tr key={model} className="border-t">
                    <td className="px-4 py-2 font-mono text-xs">{model}</td>
                    <td className="px-4 py-2">${price.promptPrice}</td>
                    <td className="px-4 py-2">${price.completionPrice}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-400 mt-2">定价修改请编辑后端 src/services/billingService.js 中的 DEFAULT_PRICING</p>
        </div>
      )}
    </div>
  );
}
