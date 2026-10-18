import { useState, useEffect } from 'react';
import api from '../../services/api';
import { toast } from '../../components/ui/Toast';

const PROVIDER_TYPES = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'azure', label: 'Azure OpenAI' },
  { value: 'anthropic', label: 'Claude' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'custom', label: '自定义' },
];

const EMPTY_FORM = { name: '', type: 'openai', baseUrl: '', weight: 1 };

/**
 * 数字输入框被清空时 parseInt 得到 NaN，JSON.stringify 又把它变成 null:
 * 轻则被后端 COALESCE 静默忽略 (界面提示"已更新"但值没变)，重则打进 NOT NULL 列报 500。
 * 所以输入过程存原始字符串，提交时统一转换。
 */
const toNum = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export default function Providers() {
  const [providers, setProviders] = useState([]);
  const [typeFilter, setTypeFilter] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingProvider, setEditingProvider] = useState(null); // null=新建模式, 否则为被编辑的服务商
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(false);

  // 密钥池与模型路由抽屉
  const [detail, setDetail] = useState(null); // 当前查看的服务商
  const [keys, setKeys] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [availability, setAvailability] = useState(null);
  const [checking, setChecking] = useState(false);
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [keyForm, setKeyForm] = useState({ keyName: '', rawKey: '' });
  const [showRouteForm, setShowRouteForm] = useState(false);
  const [routeForm, setRouteForm] = useState({ modelPattern: '', priority: 0 });
  const [rateLimit, setRateLimit] = useState(null); // 厂商级限流配置 (表单值)
  const [savingRl, setSavingRl] = useState(false);
  const [stats, setStats] = useState({ providers: [], keys: [] });
  // 动态供应商分类 (厂商类型), 接口失败时回退内置列表
  const [providerTypes, setProviderTypes] = useState(PROVIDER_TYPES);
  // 分类管理弹窗
  const [showTypesModal, setShowTypesModal] = useState(false);
  const [typeForm, setTypeForm] = useState({ code: '', label: '' });
  const [typeEditing, setTypeEditing] = useState(null);

  const load = () => api.get('/admin/providers').then(r => setProviders(r.data.data.list)).catch((err) => toast(err.response?.data?.error?.message || '加载失败', 'error'));
  const loadStats = () => api.get('/admin/stats/by-provider').then(r => setStats(r.data.data)).catch((err) => toast(err.response?.data?.error?.message || '加载失败', 'error'));
  const loadTypes = () => {
    api.get('/admin/provider-types').then(r => {
      setProviderTypes(r.data.data.list.map(t => ({ id: t.id, value: t.code, label: t.label })));
    }).catch((err) => toast(err.response?.data?.error?.message || '加载失败', 'error'));
  };

  useEffect(() => { load(); loadStats(); loadTypes(); }, []);

  const filtered = typeFilter ? providers.filter(p => p.type === typeFilter) : providers;

  const openCreate = () => { setEditingProvider(null); setForm(EMPTY_FORM); setShowForm(true); };

  // 新建或编辑提交 (根据 editingProvider 区分)
  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (editingProvider) {
        await api.put(`/admin/providers/${editingProvider.id}`, { ...form, weight: toNum(form.weight, 1) });
        toast('服务商已更新');
      } else {
        await api.post('/admin/providers', { ...form, weight: toNum(form.weight, 1) });
        toast('服务商创建成功');
      }
      setShowForm(false);
      setEditingProvider(null);
      setForm(EMPTY_FORM);
      load();
    } catch (err) { toast(err.response?.data?.error?.message || '保存失败', 'error'); }
    finally { setLoading(false); }
  };

  // 打开编辑表单 (重命名 / 修改地址 / 调整权重 / 更换类型)
  const openEdit = (p) => {
    setForm({ name: p.name, type: p.type, baseUrl: p.base_url, weight: p.weight });
    setEditingProvider(p);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingProvider(null);
    setForm(EMPTY_FORM);
  };

  const handleToggle = async (id) => {
    try {
      await api.put(`/admin/providers/${id}`, { is_active: !providers.find(p => p.id === id)?.is_active });
      toast('状态已更新');
      load();
    } catch (err) { toast('操作失败', 'error'); }
  };

  const handleDelete = async (id) => {
    if (!confirm('确定删除此服务商？关联的密钥和路由也会被删除。')) return;
    try {
      await api.delete(`/admin/providers/${id}`);
      toast('已删除');
      load();
    } catch (err) { toast('删除失败', 'error'); }
  };

  // ===== 分类管理 (新增 / 重命名 / 删除) =====
  const handleTypeSave = async () => {
    if (!typeForm.code || !typeForm.label.trim()) {
      toast('请填写分类代码和显示名称', 'error');
      return;
    }
    try {
      if (typeEditing) {
        await api.put(`/admin/provider-types/${typeEditing.id}`, { code: typeForm.code, label: typeForm.label });
        toast('分类已更新，该分类下服务商与定价已同步');
      } else {
        await api.post('/admin/provider-types', { code: typeForm.code, label: typeForm.label });
        toast('分类已创建');
      }
      setTypeEditing(null);
      setTypeForm({ code: '', label: '' });
      loadTypes();
    } catch (err) { toast(err.response?.data?.error?.message || '保存失败', 'error'); }
  };

  const openTypeEdit = (t) => {
    setTypeEditing(t);
    setTypeForm({ code: t.value, label: t.label });
  };

  const handleTypeDelete = async (t) => {
    if (!t.id) return;
    if (!confirm(`确定删除分类 ${t.label}？被服务商或定价引用时无法删除。`)) return;
    try {
      await api.delete(`/admin/provider-types/${t.id}`);
      toast('分类已删除');
      loadTypes();
    } catch (err) { toast(err.response?.data?.error?.message || '删除失败', 'error'); }
  };

  const openDetail = async (provider) => {
    setDetail(provider);
    setShowKeyForm(false);
    setShowRouteForm(false);
    setAvailability(null);
    setRateLimit(null);
    // allSettled: 可用性接口失败不应连累密钥池与路由显示为"暂无"
    try {
      const [keysRes, routesRes, availRes, rlRes] = await Promise.allSettled([
        api.get(`/admin/providers/${provider.id}/keys`),
        api.get(`/admin/providers/${provider.id}/routes`),
        api.get(`/admin/providers/${provider.id}/availability`),
        api.get(`/admin/providers/${provider.id}/ratelimit`),
      ]);
      setKeys(keysRes.status === 'fulfilled' ? keysRes.value.data.data.list : []);
      setRoutes(routesRes.status === 'fulfilled' ? routesRes.value.data.data.list : []);
      setAvailability(availRes.status === 'fulfilled' ? availRes.value.data.data : null);
      // 老服务商可能没有 rate_limit_configs 行 (建服务商时自动创建是后来加的)。
      // 没有配置也要把表单以默认值打开，否则抽屉里连"厂商速率限制"区块都不出现，无法调 429 阈值
      if (rlRes.status === 'fulfilled') {
        const c = rlRes.value.data.data.config;
        setRateLimit({
          requestsPerMinute: c?.requests_per_minute ?? 60,
          concurrentLimit: c?.concurrent_limit ?? 10,
          retryAttempts: c?.retry_attempts ?? 3,
          retryDelayMs: c?.retry_delay_ms ?? 1000,
        });
      }
    } catch { setKeys([]); setRoutes([]); setAvailability(null); }
  };

  const handleSaveRateLimit = async () => {
    if (!rateLimit) return;
    setSavingRl(true);
    try {
      await api.put(`/admin/providers/${detail.id}/ratelimit`, {
        requestsPerMinute: toNum(rateLimit.requestsPerMinute, 60),
        concurrentLimit: toNum(rateLimit.concurrentLimit, 10),
        retryAttempts: toNum(rateLimit.retryAttempts, 3),
        retryDelayMs: toNum(rateLimit.retryDelayMs, 1000),
      });
      toast('速率限制已更新，立即生效');
    } catch (err) { toast(err.response?.data?.error?.message || '保存失败', 'error'); }
    finally { setSavingRl(false); }
  };

  const handleDiscover = async () => {
    setChecking(true);
    try {
      await api.post(`/admin/providers/${detail.id}/discover`);
      toast('已开始检测，稍后刷新查看结果');
    } catch (err) { toast(err.response?.data?.error?.message || '触发失败', 'error'); }
    finally { setChecking(false); }
  };

  const handleCheckKey = async (keyId) => {
    try {
      await api.post(`/admin/providers/${detail.id}/keys/${keyId}/check`);
      toast('已开始检测该密钥');
    } catch (err) { toast('触发失败', 'error'); }
  };

  const statusBadge = (status) => {
    const map = {
      available: { label: '健康', cls: 'bg-emerald-100 text-emerald-700' },
      auth_failed: { label: '密钥失效', cls: 'bg-red-100 text-red-700' },
      unreachable: { label: '不可达', cls: 'bg-amber-100 text-amber-700' },
      unknown: { label: '未知', cls: 'bg-gray-100 text-gray-600' },
    };
    const s = map[status] || map.unknown;
    return <span className={`px-2 py-0.5 rounded text-xs ${s.cls}`}>{s.label}</span>;
  };

  const handleAddKey = async (e) => {
    e.preventDefault();
    const rawKey = (keyForm.rawKey || '').trim();
    if (!rawKey) {
      toast('请输入 API 密钥', 'error');
      return;
    }
    try {
      await api.post(`/admin/providers/${detail.id}/keys`, { keyName: keyForm.keyName?.trim() || null, rawKey });
      toast('密钥已添加');
      setShowKeyForm(false);
      setKeyForm({ keyName: '', rawKey: '' });
      openDetail(detail);
    } catch (err) { toast('添加失败', 'error'); }
  };

  const handleToggleKey = async (keyId) => {
    try {
      await api.put(`/admin/providers/${detail.id}/keys/${keyId}/toggle`);
      openDetail(detail);
    } catch (err) { toast('操作失败', 'error'); }
  };

  const handleDeleteKey = async (keyId) => {
    if (!confirm('确定删除此密钥？')) return;
    try {
      await api.delete(`/admin/providers/${detail.id}/keys/${keyId}`);
      toast('已删除');
      openDetail(detail);
    } catch (err) { toast('删除失败', 'error'); }
  };

  const handleAddRoute = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/admin/providers/${detail.id}/routes`, {
        modelPattern: routeForm.modelPattern,
        priority: toNum(routeForm.priority, 0),
      });
      toast('模型路由已添加');
      setShowRouteForm(false);
      setRouteForm({ modelPattern: '', priority: 0 });
      openDetail(detail);
    } catch (err) { toast('添加失败', 'error'); }
  };

  const handleDeleteRoute = async (routeId) => {
    try {
      await api.delete(`/admin/providers/${detail.id}/routes/${routeId}`);
      toast('已删除');
      openDetail(detail);
    } catch (err) { toast('删除失败', 'error'); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-slate-800">上游服务商管理</h2>
        <div className="flex gap-2">
          <button onClick={() => setShowTypesModal(true)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50">
            分类管理
          </button>
          <button onClick={() => (showForm ? closeForm() : openCreate())} className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700">
            {showForm ? '取消' : '+ 添加服务商'}
          </button>
        </div>
      </div>

      <div className="mb-4 flex gap-2 flex-wrap">
        <button onClick={() => setTypeFilter('')} className={`px-3 py-1.5 rounded-lg text-sm ${!typeFilter ? 'bg-primary-600 text-white' : 'bg-gray-100'}`}>全部厂商</button>
        {providerTypes.map(t => (
          <button key={t.value} onClick={() => setTypeFilter(t.value)} className={`px-3 py-1.5 rounded-lg text-sm ${typeFilter === t.value ? 'bg-primary-600 text-white' : 'bg-gray-100'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-white rounded-xl shadow-sm border p-6 mb-6 grid grid-cols-2 gap-4">
          <div className="col-span-2 text-sm font-semibold text-slate-700">
            {editingProvider ? `编辑服务商：${editingProvider.name} (可重命名 / 改地址 / 调权重)` : '添加服务商'}
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">名称</label>
            <input className="w-full border rounded-lg px-3 py-2" placeholder="OpenAI 官方" value={form.name} onChange={e => setForm({...form, name: e.target.value})} required />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">厂商类型</label>
            <select className="w-full border rounded-lg px-3 py-2" value={form.type} onChange={e => setForm({...form, type: e.target.value})}>
              {providerTypes.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div className="col-span-2">
            <label className="block text-sm font-medium mb-1">API 地址</label>
            <input className="w-full border rounded-lg px-3 py-2" placeholder="https://api.openai.com" value={form.baseUrl} onChange={e => setForm({...form, baseUrl: e.target.value})} required />
            <p className="text-xs text-slate-400 mt-1">支持带 /v1 或不带 /v1 结尾，系统自动适配；末尾多余 / 会被忽略</p>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">权重</label>
            <input type="number" className="w-full border rounded-lg px-3 py-2" value={form.weight} onChange={e => setForm({...form, weight: e.target.value})} />
          </div>
          <div className="flex items-end">
            <button type="submit" disabled={loading} className="w-full py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50">
              {loading ? '保存中...' : (editingProvider ? '保存修改' : '创建服务商')}
            </button>
          </div>
        </form>
      )}

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr><th className="text-left px-4 py-3 text-sm font-medium text-slate-600">名称</th><th className="text-left px-4 py-3 text-sm font-medium text-slate-600">厂商</th><th className="text-left px-4 py-3 text-sm font-medium text-slate-600">地址</th><th className="text-left px-4 py-3 text-sm font-medium text-slate-600">权重</th><th className="text-left px-4 py-3 text-sm font-medium text-slate-600">状态</th><th className="text-left px-4 py-3 text-sm font-medium text-slate-600">操作</th></tr>
          </thead>
          <tbody>
            {filtered.map(p => (
              <tr key={p.id} className="border-t">
                <td className="px-4 py-3 font-medium">{p.name}</td>
                <td className="px-4 py-3"><span className="bg-slate-100 px-2 py-0.5 rounded text-xs">{providerTypes.find(t => t.value === p.type)?.label || p.type}</span></td>
                <td className="px-4 py-3 text-sm text-slate-500">{p.base_url}</td>
                <td className="px-4 py-3">{p.weight}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded text-xs ${p.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                    {p.is_active ? '启用' : '禁用'}
                  </span>
                </td>
                <td className="px-4 py-3 space-x-2">
                  <button onClick={() => openDetail(p)} className="text-primary-600 hover:underline text-sm">密钥与路由</button>
                  <button onClick={() => openEdit(p)} className="text-emerald-600 hover:underline text-sm">编辑</button>
                  <button onClick={() => handleToggle(p.id)} className="text-blue-600 hover:underline text-sm">{p.is_active ? '禁用' : '启用'}</button>
                  <button onClick={() => handleDelete(p.id)} className="text-red-600 hover:underline text-sm">删除</button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && <tr><td colSpan="6" className="text-center py-8 text-slate-400">暂无服务商</td></tr>}
          </tbody>
        </table>
      </div>

      {/* 厂商 Key 累计用量统计 */}
      <div className="mt-8">
        <h3 className="font-semibold text-lg mb-4">各厂商 Key 累计用量与成本</h3>
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left">厂商</th><th className="px-4 py-2 text-left">请求数</th>
                <th className="px-4 py-2 text-left">Token</th><th className="px-4 py-2 text-left">成本</th><th className="px-4 py-2 text-left">平均延迟</th>
              </tr>
            </thead>
            <tbody>
              {stats.providers.map(s => (
                <tr key={`${s.provider_name}-${s.provider_type}`} className="border-t">
                  <td className="px-4 py-2">{s.provider_name} <span className="text-xs bg-slate-100 px-1.5 py-0.5 rounded">{s.provider_type}</span></td>
                  <td className="px-4 py-2">{s.request_count}</td>
                  <td className="px-4 py-2">{(s.total_tokens || 0).toLocaleString()}</td>
                  <td className="px-4 py-2 font-mono">${parseFloat(s.total_cost || 0).toFixed(4)}</td>
                  <td className="px-4 py-2">{Math.round(s.avg_latency_ms)}ms</td>
                </tr>
              ))}
              {stats.providers.length === 0 && <tr><td colSpan="5" className="text-center py-6 text-slate-400">暂无请求记录</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="mt-4 bg-white rounded-xl shadow-sm border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left">厂商密钥</th><th className="px-4 py-2 text-left">名称</th>
                <th className="px-4 py-2 text-left">累计使用</th><th className="px-4 py-2 text-left">最近使用</th><th className="px-4 py-2 text-left">状态</th>
              </tr>
            </thead>
            <tbody>
              {stats.keys.map(k => (
                <tr key={k.id} className="border-t">
                  <td className="px-4 py-2">{k.provider_name}</td>
                  <td className="px-4 py-2">{k.key_name || '-'}</td>
                  <td className="px-4 py-2">{k.usage_count} 次</td>
                  <td className="px-4 py-2">{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : '从未'}</td>
                  <td className="px-4 py-2">
                    <span className={`px-1.5 py-0.5 rounded text-xs ${k.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                      {k.is_active ? '启用' : '禁用'}
                    </span>
                    {k.cooldown_until && new Date(k.cooldown_until) > new Date() && (
                      <span className="ml-2 px-1.5 py-0.5 rounded text-xs bg-amber-100 text-amber-700">冷却中</span>
                    )}
                  </td>
                </tr>
              ))}
              {stats.keys.length === 0 && <tr><td colSpan="5" className="text-center py-6 text-slate-400">暂无密钥</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* 密钥与路由管理抽屉 */}
      {detail && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center overflow-y-auto p-4 z-50" onClick={() => setDetail(null)}>
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[calc(100vh-2rem)] overflow-y-auto my-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-lg">{detail.name} - 密钥池与模型路由</h3>
              <button onClick={() => setDetail(null)} className="text-slate-400 hover:text-slate-600" aria-label="关闭">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5"><path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" /></svg>
              </button>
            </div>

            <div className="flex justify-between items-center mb-2">
              <h4 className="font-semibold">密钥池 ({keys.length})</h4>
              <div className="space-x-2">
                <button onClick={handleDiscover} disabled={checking} className="text-sm text-emerald-600 hover:underline disabled:opacity-50">
                  {checking ? '检测中...' : '全部立即检测'}
                </button>
                <button onClick={() => setShowKeyForm(!showKeyForm)} className="text-sm text-primary-600">+ 添加密钥</button>
              </div>
            </div>
            {showKeyForm && (
              <form onSubmit={handleAddKey} className="bg-gray-50 rounded-lg p-4 mb-3 space-y-2">
                <input className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="密钥名称 (可选)" value={keyForm.keyName} onChange={e => setKeyForm({...keyForm, keyName: e.target.value})} />
                <input className="w-full border rounded-lg px-3 py-2 text-sm font-mono" placeholder="sk-... API 密钥" value={keyForm.rawKey} onChange={e => setKeyForm({...keyForm, rawKey: e.target.value})} required />
                <button type="submit" className="px-4 py-1.5 bg-emerald-600 text-white rounded-lg text-sm">添加</button>
              </form>
            )}
            <div className="space-y-2 mb-4">
              {keys.map(k => {
                const summary = availability?.keySummary?.find(s => s.key_id === k.id);
                const health = summary
                  ? (summary.auth_failed_count > 0 ? 'auth_failed' : (summary.unreachable_count > 0 ? 'unreachable' : (summary.model_count > 0 ? 'available' : 'unknown')))
                  : 'unknown';
                return (
                  <div key={k.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-sm">
                    <div>
                      <span className="font-medium">{k.key_name || '未命名'}</span>
                      <span className="ml-3 text-xs text-slate-500">
                        模型 {summary?.model_count || 0} · 累计 {k.usage_count} 次
                      </span>
                      {k.cooldown_until && new Date(k.cooldown_until) > new Date() && <span className="ml-2 text-xs text-amber-600">冷却中</span>}
                    </div>
                    <div className="space-x-3 flex items-center">
                      {statusBadge(health)}
                      <button onClick={() => handleCheckKey(k.id)} className="text-emerald-600 text-xs">检测</button>
                      <span className={`text-xs ${k.is_active ? 'text-emerald-600' : 'text-red-500'}`}>{k.is_active ? '启用' : '禁用'}</span>
                      <button onClick={() => handleToggleKey(k.id)} className="text-blue-600 text-xs">{k.is_active ? '禁用' : '启用'}</button>
                      <button onClick={() => handleDeleteKey(k.id)} className="text-red-600 text-xs">删除</button>
                    </div>
                  </div>
                );
              })}
              {keys.length === 0 && <p className="text-sm text-slate-400">暂无密钥</p>}
            </div>

            {/* 模型可用性明细 */}
            {availability && availability.models.length > 0 && (
              <div className="mb-4">
                <h4 className="font-semibold mb-2">模型可用性 (每 {availability.intervalMinutes} 分钟自动检测)</h4>
                <div className="border rounded-lg max-h-56 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr>
                        <th className="sticky top-0 z-10 bg-gray-50 px-2 py-1.5 text-left">模型</th>
                        <th className="sticky top-0 z-10 bg-gray-50 px-2 py-1.5 text-left">Key</th>
                        <th className="sticky top-0 z-10 bg-gray-50 px-2 py-1.5 text-left">状态</th>
                        <th className="sticky top-0 z-10 bg-gray-50 px-2 py-1.5 text-left">延迟</th>
                        <th className="sticky top-0 z-10 bg-gray-50 px-2 py-1.5 text-left">原因</th>
                        <th className="sticky top-0 z-10 bg-gray-50 px-2 py-1.5 text-left">检测时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {availability.models.map(m => (
                        <tr key={m.id} className="border-t">
                          <td className="px-2 py-1.5 font-mono">{m.model === '__key__' ? '密钥整体状态' : m.model}</td>
                          <td className="px-2 py-1.5">{m.key_name || '-'}</td>
                          <td className="px-2 py-1.5">{statusBadge(m.status)}</td>
                          <td className="px-2 py-1.5">{m.latency_ms ? `${m.latency_ms}ms` : '-'}</td>
                          <td className="px-2 py-1.5 text-red-600 max-w-[220px] truncate" title={m.error || ''}>{m.error || '-'}</td>
                          <td className="px-2 py-1.5">{m.checked_at ? new Date(m.checked_at).toLocaleString() : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* 厂商速率限制 */}
            {rateLimit && (
              <div className="mb-4">
                <h4 className="font-semibold mb-2">厂商速率限制</h4>
                <div className="grid grid-cols-2 gap-2 bg-gray-50 rounded-lg p-3">
                  <label className="text-xs text-slate-500">
                    每分钟请求数
                    <input type="number" min="1" max="100000" className="mt-1 w-full border rounded px-2 py-1.5 text-sm text-slate-800" value={rateLimit.requestsPerMinute} onChange={e => setRateLimit({...rateLimit, requestsPerMinute: e.target.value})} />
                  </label>
                  <label className="text-xs text-slate-500">
                    并发上限
                    <input type="number" min="1" max="1000" className="mt-1 w-full border rounded px-2 py-1.5 text-sm text-slate-800" value={rateLimit.concurrentLimit} onChange={e => setRateLimit({...rateLimit, concurrentLimit: e.target.value})} />
                  </label>
                  <label className="text-xs text-slate-500">
                    失败重试次数
                    <input type="number" min="1" max="10" className="mt-1 w-full border rounded px-2 py-1.5 text-sm text-slate-800" value={rateLimit.retryAttempts} onChange={e => setRateLimit({...rateLimit, retryAttempts: e.target.value})} />
                  </label>
                  <label className="text-xs text-slate-500">
                    重试间隔 (毫秒)
                    <input type="number" min="0" max="60000" className="mt-1 w-full border rounded px-2 py-1.5 text-sm text-slate-800" value={rateLimit.retryDelayMs} onChange={e => setRateLimit({...rateLimit, retryDelayMs: e.target.value})} />
                  </label>
                </div>
                <div className="flex items-center gap-3 mt-2">
                  <button onClick={handleSaveRateLimit} disabled={savingRl} className="px-4 py-1.5 bg-emerald-600 text-white rounded-lg text-sm disabled:opacity-50">
                    {savingRl ? '保存中...' : '保存限流配置'}
                  </button>
                  <span className="text-xs text-slate-400">超限请求返回 429，对上游密钥故障转移与熔断阈值同样生效</span>
                </div>
              </div>
            )}

            <div className="flex justify-between items-center mb-2">
              <h4 className="font-semibold">模型路由 ({routes.length})</h4>
              <button onClick={() => setShowRouteForm(!showRouteForm)} className="text-sm text-primary-600">+ 添加路由</button>
            </div>
            {showRouteForm && (
              <form onSubmit={handleAddRoute} className="bg-gray-50 rounded-lg p-4 mb-3 flex gap-2">
                <input className="flex-1 border rounded-lg px-3 py-2 text-sm font-mono" placeholder="gpt-4* (支持通配符)" value={routeForm.modelPattern} onChange={e => setRouteForm({...routeForm, modelPattern: e.target.value})} required />
                <input type="number" className="w-24 border rounded-lg px-3 py-2 text-sm" placeholder="优先级" value={routeForm.priority} onChange={e => setRouteForm({...routeForm, priority: e.target.value})} />
                <button type="submit" className="px-4 py-1.5 bg-emerald-600 text-white rounded-lg text-sm">添加</button>
              </form>
            )}
            <div className="space-y-2">
              {routes.map(r => (
                <div key={r.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-sm">
                  <span className="font-mono">{r.model_pattern}</span>
                  <div className="space-x-3">
                    <span className="text-xs text-slate-500">优先级 {r.priority}</span>
                    <button onClick={() => handleDeleteRoute(r.id)} className="text-red-600 text-xs">删除</button>
                  </div>
                </div>
              ))}
              {routes.length === 0 && <p className="text-sm text-slate-400">暂无路由，未匹配模型将回退到默认服务商</p>}
            </div>
          </div>
        </div>
      )}
      {/* 分类管理弹窗 */}
      {showTypesModal && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center overflow-y-auto p-4 z-50" onClick={() => setShowTypesModal(false)}>
          <div className="bg-white rounded-xl p-6 w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto my-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold">供应商分类管理</h3>
              <button onClick={() => setShowTypesModal(false)} className="text-slate-400 hover:text-slate-600" aria-label="关闭">✕</button>
            </div>
            <p className="text-xs text-slate-400 mb-4">
              分类（厂商类型）用于给服务商分组。重命名会同步更新该分类下的服务商与定价；有服务商或定价引用时不能删除。
            </p>

            <div className="space-y-2 mb-4">
              {providerTypes.map(t => (
                <div key={t.id || t.value} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-sm">
                  <span><span className="font-medium">{t.label}</span> <span className="ml-1 text-xs text-slate-400 font-mono">{t.value}</span></span>
                  <div className="space-x-3">
                    <button onClick={() => openTypeEdit(t)} className="text-blue-600 hover:underline text-xs">重命名</button>
                    <button onClick={() => handleTypeDelete(t)} className="text-red-600 hover:underline text-xs">删除</button>
                  </div>
                </div>
              ))}
              {providerTypes.length === 0 && <p className="text-sm text-slate-400">暂无分类</p>}
            </div>

            <div className="border-t pt-3">
              <h4 className="text-sm font-medium mb-2">{typeEditing ? `重命名分类：${typeEditing.label}` : '新增分类'}</h4>
              <div className="space-y-2 mb-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">分类代码（小写字母/数字/下划线）</label>
                  <input className="w-full border rounded-lg px-3 py-2 text-sm font-mono" placeholder="如 deepseek" value={typeForm.code} onChange={e => setTypeForm({...typeForm, code: e.target.value})} />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">显示名称</label>
                  <input className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="如 DeepSeek" value={typeForm.label} onChange={e => setTypeForm({...typeForm, label: e.target.value})} />
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={handleTypeSave} className="px-4 py-1.5 bg-emerald-600 text-white rounded-lg text-sm">{typeEditing ? '保存修改' : '新增分类'}</button>
                {typeEditing && (
                  <button onClick={() => { setTypeEditing(null); setTypeForm({ code: '', label: '' }); }} className="px-4 py-1.5 border rounded-lg text-sm">取消编辑</button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
