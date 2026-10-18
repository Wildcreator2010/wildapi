import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../services/api';
import { toast } from '../../components/ui/Toast';

export default function UsageHistory() {
  const [records, setRecords] = useState({ list: [], total: 0 });
  const [page, setPage] = useState(1);
  const [model, setModel] = useState('');
  const [showRecharge, setShowRecharge] = useState(false);
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [cooldownLeft, setCooldownLeft] = useState(0);
  const seqRef = useRef(0);

  const load = useCallback(() => {
    const seq = ++seqRef.current;
    api.get('/user/usage', { params: { page, pageSize: 20, model } })
      .then(r => {
        // 只应用最新一次请求的结果，避免按模型筛选时慢响应覆盖新结果
        if (seq === seqRef.current) setRecords(r.data.data);
      })
      .catch((err) => toast(err.response?.data?.error?.message || '加载失败', 'error'));
  }, [page, model]);

  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  // 冷却倒计时
  useEffect(() => {
    if (cooldownLeft <= 0) return;
    const t = setTimeout(() => setCooldownLeft(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldownLeft]);

  const handleRechargeRequest = async () => {
    if (submitting) return;
    const amount = parseFloat(rechargeAmount);
    if (!amount || amount <= 0) {
      toast('请输入有效金额', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/user/recharge-request', { amount });
      toast('充值请求已提交，管理员将尽快处理');
      setShowRecharge(false);
      setCooldownLeft(300); // 本地 5 分钟冷却倒计时
    } catch (err) {
      toast(err.response?.data?.error?.message || '请求失败', 'error');
      if (err.response?.status === 429) {
        setShowRecharge(false);
        setCooldownLeft(300);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-slate-800">使用记录</h2>
        <button
          onClick={() => setShowRecharge(true)}
          disabled={cooldownLeft > 0}
          className={`px-4 py-2 rounded-lg ${cooldownLeft > 0 ? 'bg-gray-300 cursor-not-allowed text-gray-500' : 'bg-emerald-600 text-white hover:bg-emerald-700'}`}
        >
          {cooldownLeft > 0 ? `充值 (${Math.floor(cooldownLeft / 60)}:${String(cooldownLeft % 60).padStart(2, '0')})` : '充值'}
        </button>
      </div>

      <div className="mb-4">
        <input className="border rounded-lg px-3 py-2 w-40" placeholder="筛选模型..." value={model} onChange={e => { setModel(e.target.value); setPage(1); }} />
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-3">时间</th><th className="text-left px-4 py-3">模型</th>
              <th className="text-left px-4 py-3">Token 输入</th><th className="text-left px-4 py-3">Token 输出</th>
              <th className="text-left px-4 py-3">费用</th><th className="text-left px-4 py-3">延迟</th><th className="text-left px-4 py-3">状态</th>
            </tr>
          </thead>
          <tbody>
            {records.list.map(r => (
              <tr key={r.id} className="border-t">
                <td className="px-4 py-3 text-xs">{new Date(r.created_at).toLocaleString()}</td>
                <td className="px-4 py-3 font-mono text-xs">{r.model}</td>
                <td className="px-4 py-3">{r.tokens_in}</td>
                <td className="px-4 py-3">{r.tokens_out}</td>
                <td className="px-4 py-3 font-mono text-xs">${parseFloat(r.cost).toFixed(4)}</td>
                <td className="px-4 py-3">{r.latency_ms}ms</td>
                <td className="px-4 py-3">
                  <span className={`px-1.5 py-0.5 rounded text-xs ${r.status_code < 300 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                    {r.status_code}
                  </span>
                </td>
              </tr>
            ))}
            {records.list.length === 0 && <tr><td colSpan="7" className="text-center py-8 text-slate-400">暂无使用记录</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="flex justify-between mt-4">
        <span>共 {records.total} 条</span>
        <div className="space-x-2">
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="px-3 py-1 border rounded disabled:opacity-30">上一页</button>
          <button disabled={page >= Math.ceil(records.total / 20)} onClick={() => setPage(p => p + 1)} className="px-3 py-1 border rounded disabled:opacity-30">下一页</button>
        </div>
      </div>

      {showRecharge && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center overflow-y-auto p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-sm my-auto">
            <h3 className="font-bold mb-4">充值请求</h3>
            <p className="text-sm text-slate-500 mb-4">提交充值金额，管理员将在收到通知后为您处理</p>
            <input type="number" className="w-full border rounded-lg px-3 py-2 mb-4" placeholder="充值金额 ($)" value={rechargeAmount} onChange={e => setRechargeAmount(e.target.value)} />
            <div className="flex gap-3">
              <button onClick={() => setShowRecharge(false)} className="flex-1 py-2 border rounded-lg">取消</button>
              <button
                onClick={handleRechargeRequest}
                disabled={submitting}
                className="flex-1 py-2 bg-emerald-600 text-white rounded-lg disabled:opacity-60"
              >
                {submitting ? '提交中...' : '提交请求'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
