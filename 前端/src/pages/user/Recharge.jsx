import { useState, useEffect } from 'react';
import api from '../../services/api';
import useAuthStore from '../../store/authStore';
import { toast } from '../../components/ui/Toast';

const QUICK_AMOUNTS = [10, 50, 100, 500];

export default function Recharge() {
  const { user } = useAuthStore();
  const [balance, setBalance] = useState(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadBalance = () => {
    api.get('/user/dashboard').then(r => setBalance(r.data.data.balance)).catch((err) => toast(err.response?.data?.error?.message || '加载失败', 'error'));
  };

  useEffect(() => { loadBalance(); }, []);

  // 非超管访问时跳转提示
  if (user && user.role !== 'superadmin') {
    return (
      <div className="bg-white rounded-xl shadow-sm border p-8 text-center">
        <h2 className="text-xl font-bold text-slate-800 mb-2">无权访问</h2>
        <p className="text-slate-500">自助充值仅限超级管理员使用</p>
      </div>
    );
  }

  const handleSubmit = async () => {
    const parsed = parseFloat(amount);
    if (!parsed || isNaN(parsed) || parsed <= 0) {
      toast('请输入有效的充值金额', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const r = await api.post('/admin/self-recharge', { amount: parsed, note: note || undefined });
      toast(r.data.message || '充值成功');
      setAmount('');
      setNote('');
      loadBalance();
    } catch (err) {
      toast(err.response?.data?.error?.message || '充值失败', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <h2 className="text-2xl font-bold text-slate-800 mb-6">自助充值</h2>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-4xl">
        {/* 当前余额 */}
        <div className="bg-white rounded-xl shadow-sm border p-6">
          <div className="text-sm text-slate-500 mb-1">当前余额</div>
          <div className="text-4xl font-bold text-slate-800">
            {balance !== null ? `$${balance.toFixed(4)}` : '-'}
          </div>
          <p className="text-xs text-slate-400 mt-3">
            充值立即到账并写入余额流水，可在「余额明细」中查看记录。
            使用该余额调用平台 API 时，费用按定价配置实时扣除。
          </p>
        </div>

        {/* 充值表单 */}
        <div className="bg-white rounded-xl shadow-sm border p-6">
          <div className="text-sm font-medium text-slate-700 mb-3">快捷金额</div>
          <div className="flex gap-2 mb-4">
            {QUICK_AMOUNTS.map(v => (
              <button
                key={v}
                onClick={() => setAmount(String(v))}
                className={`px-4 py-2 rounded-lg border text-sm ${
                  amount === String(v)
                    ? 'border-primary-600 bg-primary-50 text-primary-700'
                    : 'border-gray-200 hover:border-primary-400 text-slate-600'
                }`}
              >
                ${v}
              </button>
            ))}
          </div>

          <label className="block text-sm font-medium text-slate-700 mb-1">充值金额 (美元)</label>
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="输入金额"
            className="w-full border rounded-lg px-3 py-2 mb-4"
          />

          <label className="block text-sm font-medium text-slate-700 mb-1">备注 (可选)</label>
          <input
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="便于识别的充值备注"
            maxLength={200}
            className="w-full border rounded-lg px-3 py-2 mb-5"
          />

          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="w-full py-2.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-60"
          >
            {submitting ? '充值中...' : '确认充值'}
          </button>
        </div>
      </div>
    </div>
  );
}
