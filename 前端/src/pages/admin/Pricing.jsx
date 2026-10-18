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

const EMPTY_FORM = {
  modelPattern: '',
  providerType: 'openai',
  priceMode: 'upstream', // upstream=跟随上游成本×倍率, custom=自定义价格
  promptPrice: '',
  completionPrice: '',
  multiplier: '1.5',
};

export default function Pricing() {
  const [list, setList] = useState([]);
  const [providerTypes, setProviderTypes] = useState(PROVIDER_TYPES); // 动态分类, 失败回退内置
  const [candidates, setCandidates] = useState([]); // 可定价模型候选（下拉选择）
  const [typeFilter, setTypeFilter] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  // 批量调整
  const [showBatch, setShowBatch] = useState(false);
  const [batchForm, setBatchForm] = useState({ action: 'multiply', multiplier: '1.2', scope: 'all' });
  const [applyingBatch, setApplyingBatch] = useState(false);

  const load = () => {
    api.get('/admin/pricing').then(r => {
      setList(r.data.data.list);
      if (r.data.data.providerTypes && r.data.data.providerTypes.length > 0) {
        setProviderTypes(r.data.data.providerTypes);
      }
    }).catch((err) => toast(err.response?.data?.error?.message || '加载失败', 'error'));
  };

  const loadCandidates = () => {
    api.get('/admin/pricing/available-models').then(r => setCandidates(r.data.data.models || [])).catch((err) => toast(err.response?.data?.error?.message || '加载失败', 'error'));
  };

  useEffect(() => { load(); loadCandidates(); }, []);

  const filtered = typeFilter ? list.filter(p => p.provider_type === typeFilter) : list;

  const openCreate = () => { setEditing(null); setForm(EMPTY_FORM); setShowForm(true); };
  const openEdit = (item) => {
    const p = parseFloat(item.prompt_price);
    const c = parseFloat(item.completion_price);
    setEditing(item);
    setForm({
      modelPattern: item.model_pattern,
      providerType: item.provider_type,
      // 输入输出价格都为 0 = 跟随上游成本
      priceMode: (p === 0 && c === 0) ? 'upstream' : 'custom',
      promptPrice: String(p),
      completionPrice: String(c),
      multiplier: String(parseFloat(item.multiplier || 1)),
    });
    setShowForm(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    const modelPattern = form.modelPattern.trim();
    if (!modelPattern) {
      toast('请选择或输入模型名', 'error');
      return;
    }
    const multiplier = parseFloat(form.multiplier);
    if (!multiplier || multiplier <= 0) {
      toast('倍率必须大于 0', 'error');
      return;
    }
    // 跟随上游模式: 价格为 0, 计费时自动取上游成本 x 倍率
    const promptPrice = form.priceMode === 'upstream' ? 0 : parseFloat(form.promptPrice);
    const completionPrice = form.priceMode === 'upstream' ? 0 : parseFloat(form.completionPrice);
    if (form.priceMode === 'custom' && (isNaN(promptPrice) || isNaN(completionPrice))) {
      toast('请填写输入/输出价格', 'error');
      return;
    }
    const body = {
      modelPattern,
      providerType: form.providerType,
      promptPrice: promptPrice || 0,
      completionPrice: completionPrice || 0,
      multiplier,
    };
    try {
      if (editing) {
        await api.put(`/admin/pricing/${editing.id}`, body);
        toast('定价已更新，代理扣费立即生效');
      } else {
        await api.post('/admin/pricing', body);
        toast('定价已创建，代理扣费立即生效');
      }
      setShowForm(false);
      load();
    } catch (err) { toast(err.response?.data?.error?.message || '保存失败', 'error'); }
  };

  const handleToggle = async (item) => {
    try {
      await api.put(`/admin/pricing/${item.id}`, { is_active: item.is_active ? 0 : 1 });
      toast('状态已更新');
      load();
    } catch (err) { toast('操作失败', 'error'); }
  };

  const handleDelete = async (item) => {
    if (!confirm(`确定删除定价 ${item.model_pattern} (${item.provider_type})？`)) return;
    try {
      await api.delete(`/admin/pricing/${item.id}`);
      toast('已删除');
      load();
    } catch (err) { toast('删除失败', 'error'); }
  };

  // 批量调整倍率
  const handleBatchApply = async () => {
    const m = parseFloat(batchForm.multiplier);
    if (!m || m <= 0) {
      toast('倍率必须大于 0', 'error');
      return;
    }
    const scopeLabel = { all: '全部启用项', upstream: '仅"跟随上游"项', custom: '仅"自定义价格"项' }[batchForm.scope];
    const actionLabel = batchForm.action === 'set' ? '设为' : '乘以';
    if (!confirm(`确定将 ${scopeLabel}的倍率${actionLabel} ${m} 吗？此操作立即生效。`)) return;

    setApplyingBatch(true);
    try {
      const r = await api.post('/admin/pricing/batch', {
        action: batchForm.action,
        multiplier: m,
        scope: batchForm.scope,
      });
      toast(r.data.message || '批量调整完成');
      setShowBatch(false);
      load();
    } catch (err) { toast(err.response?.data?.error?.message || '批量调整失败', 'error'); }
    finally { setApplyingBatch(false); }
  };

  const enabledCount = list.filter(p => p.is_active).length;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-2xl font-bold text-slate-800">定价配置</h2>
        <div className="flex gap-2">
          <button onClick={() => setShowBatch(!showBatch)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50">
            {showBatch ? '收起批量调整' : '⚡ 批量调整'}
          </button>
          <button onClick={openCreate} className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700">
            + 新增定价
          </button>
        </div>
      </div>

      <p className="text-sm text-slate-500 mb-3">
        共 {list.length} 条定价，启用 {enabledCount} 条。未配置的模型按内置默认定价计费。
      </p>

      {showBatch && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
          <h3 className="text-sm font-semibold text-amber-800 mb-2">批量调整倍率（一键加价/调价）</h3>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs text-amber-700 mb-1">操作</label>
              <select className="border rounded-lg px-3 py-2 text-sm" value={batchForm.action} onChange={e => setBatchForm({...batchForm, action: e.target.value})}>
                <option value="multiply">当前倍率 × 输入值</option>
                <option value="set">直接设为输入值</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-amber-700 mb-1">倍率</label>
              <input type="number" step="0.01" min="0.01" className="w-24 border rounded-lg px-3 py-2 text-sm" value={batchForm.multiplier} onChange={e => setBatchForm({...batchForm, multiplier: e.target.value})} />
            </div>
            <div>
              <label className="block text-xs text-amber-700 mb-1">范围</label>
              <select className="border rounded-lg px-3 py-2 text-sm" value={batchForm.scope} onChange={e => setBatchForm({...batchForm, scope: e.target.value})}>
                <option value="all">全部启用项</option>
                <option value="upstream">仅"跟随上游"项</option>
                <option value="custom">仅"自定义价格"项</option>
              </select>
            </div>
            <button onClick={handleBatchApply} disabled={applyingBatch} className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm disabled:opacity-50">
              {applyingBatch ? '应用中...' : '应用'}
            </button>
            <p className="text-xs text-amber-600 w-full mt-1">例：全部×1.2 = 统一加价 20%；设为 1.0 = 全部恢复原价。操作有确认弹窗，立即生效。</p>
          </div>
        </div>
      )}

      <p className="text-sm text-slate-500 mb-4 -mt-2">
        给模型定一个"卖价"：<b>跟随上游</b> = 按上游成本自动加价（只填倍率，最省心）；<b>自定义价格</b> = 手动填输入/输出单价（美元 / 1K tokens）。
        未配置的模型按内置默认定价计费。
      </p>

      <div className="mb-4 flex gap-2 flex-wrap">
        <button onClick={() => setTypeFilter('')} className={`px-3 py-1.5 rounded-lg text-sm ${!typeFilter ? 'bg-primary-600 text-white' : 'bg-gray-100'}`}>全部厂商</button>
        {providerTypes.map(t => (
          <button key={t.value} onClick={() => setTypeFilter(t.value)} className={`px-3 py-1.5 rounded-lg text-sm ${typeFilter === t.value ? 'bg-primary-600 text-white' : 'bg-gray-100'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {showForm && (
        <form onSubmit={handleSave} className="bg-white rounded-xl shadow-sm border p-6 mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2 flex items-center justify-between">
            <h3 className="font-semibold">{editing ? `编辑定价：${editing.model_pattern}` : '新增定价'}</h3>
            <button type="button" onClick={() => setShowForm(false)} className="text-sm text-slate-400 hover:text-slate-600">关闭</button>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">模型</label>
            <input
              className="w-full border rounded-lg px-3 py-2 font-mono text-sm"
              list="pricing-model-candidates"
              placeholder="选择或输入模型名，如 deepseek-v4-flash"
              value={form.modelPattern}
              onChange={e => setForm({...form, modelPattern: e.target.value})}
              required
            />
            <datalist id="pricing-model-candidates">
              {candidates.map(m => <option key={m} value={m} />)}
            </datalist>
            <p className="text-xs text-slate-400 mt-1">支持通配，如 <code>gpt-4*</code> 可匹配多个模型</p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">厂商</label>
            <select className="w-full border rounded-lg px-3 py-2" value={form.providerType} onChange={e => setForm({...form, providerType: e.target.value})}>
              {providerTypes.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">定价方式</label>
            <select className="w-full border rounded-lg px-3 py-2" value={form.priceMode} onChange={e => setForm({...form, priceMode: e.target.value})}>
              <option value="upstream">跟随上游成本 × 倍率（推荐）</option>
              <option value="custom">自定义价格</option>
            </select>
          </div>

          {form.priceMode === 'custom' ? (
            <>
              <div>
                <label className="block text-sm font-medium mb-1">输入价格 ($/1K)</label>
                <input type="number" step="0.000001" min="0" className="w-full border rounded-lg px-3 py-2" value={form.promptPrice} onChange={e => setForm({...form, promptPrice: e.target.value})} required />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">输出价格 ($/1K)</label>
                <input type="number" step="0.000001" min="0" className="w-full border rounded-lg px-3 py-2" value={form.completionPrice} onChange={e => setForm({...form, completionPrice: e.target.value})} required />
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-500 self-end pb-2">
              用户价 = 上游实际成本 × 倍率，上游涨价自动跟随，无需频繁维护
            </p>
          )}

          <div>
            <label className="block text-sm font-medium mb-1">倍率 (x)</label>
            <input type="number" step="0.01" min="0.01" className="w-full border rounded-lg px-3 py-2" value={form.multiplier} onChange={e => setForm({...form, multiplier: e.target.value})} required />
            <p className="text-xs text-slate-400 mt-1">例：1.5 = 加价 50%</p>
          </div>

          <div className="md:col-span-2 flex gap-3">
            <button type="submit" className="px-6 py-2 bg-emerald-600 text-white rounded-lg">{editing ? '保存修改' : '创建定价'}</button>
            <button type="button" onClick={() => setShowForm(false)} className="px-6 py-2 border rounded-lg">取消</button>
          </div>
        </form>
      )}

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-3">模型</th>
              <th className="text-left px-4 py-3">厂商</th>
              <th className="text-left px-4 py-3">定价方式</th>
              <th className="text-left px-4 py-3">输入价 ($/1K)</th>
              <th className="text-left px-4 py-3">输出价 ($/1K)</th>
              <th className="text-left px-4 py-3">倍率</th>
              <th className="text-left px-4 py-3">状态</th>
              <th className="text-left px-4 py-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(p => {
              const upstream = parseFloat(p.prompt_price) === 0 && parseFloat(p.completion_price) === 0;
              return (
                <tr key={p.id} className="border-t">
                  <td className="px-4 py-3 font-mono">{p.model_pattern}</td>
                  <td className="px-4 py-3">
                    <span className="bg-slate-100 px-2 py-0.5 rounded text-xs">{providerTypes.find(t => t.value === p.provider_type)?.label || p.provider_type}</span>
                  </td>
                  <td className="px-4 py-3">
                    {upstream
                      ? <span className="px-2 py-0.5 rounded text-xs bg-sky-100 text-sky-700">跟随上游</span>
                      : <span className="px-2 py-0.5 rounded text-xs bg-indigo-100 text-indigo-700">自定义</span>}
                  </td>
                  <td className="px-4 py-3 font-mono">{upstream ? '自动' : `$${parseFloat(p.prompt_price).toFixed(6)}`}</td>
                  <td className="px-4 py-3 font-mono">{upstream ? '自动' : `$${parseFloat(p.completion_price).toFixed(6)}`}</td>
                  <td className="px-4 py-3 font-mono">x{parseFloat(p.multiplier || 1).toFixed(2)}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs ${p.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                      {p.is_active ? '启用' : '禁用'}
                    </span>
                  </td>
                  <td className="px-4 py-3 space-x-2">
                    <button onClick={() => openEdit(p)} className="text-blue-600 hover:underline">编辑</button>
                    <button onClick={() => handleToggle(p)} className="text-amber-600 hover:underline">{p.is_active ? '禁用' : '启用'}</button>
                    <button onClick={() => handleDelete(p)} className="text-red-600 hover:underline">删除</button>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && <tr><td colSpan="8" className="text-center py-8 text-slate-400">暂无定价配置，未配置模型将按内置默认定价计费</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
