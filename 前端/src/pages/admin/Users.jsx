import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../services/api';
import { toast } from '../../components/ui/Toast';

export default function Users() {
  const [users, setUsers] = useState({ list: [], total: 0 });
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [rechargeModal, setRechargeModal] = useState(null);
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [concurrencyModal, setConcurrencyModal] = useState(null);
  const [concurrencyValue, setConcurrencyValue] = useState('');
  const [rpmModal, setRpmModal] = useState(null);
  const [rpmValue, setRpmValue] = useState('');
  const [actorRole, setActorRole] = useState('admin');
  const seqRef = useRef(0);

  const load = useCallback(() => {
    const seq = ++seqRef.current;
    api.get('/admin/users', { params: { page, search, pageSize: 20 } })
      .then(r => {
        // 只认最新一次请求: 边打字边发时先发的慢响应会覆盖后发的，表格显示早已改掉的关键词结果
        if (seq !== seqRef.current) return;
        setUsers(r.data.data);
        if (r.data.data.actorRole) setActorRole(r.data.data.actorRole);
      })
      .catch((err) => toast(err.response?.data?.error?.message || '加载失败', 'error'));
  }, [page, search]);

  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  const openRechargeModal = (user) => {
    setRechargeAmount('');
    setRechargeModal(user);
  };

  const handleRecharge = async () => {
    const amount = parseFloat(rechargeAmount);
    if (!amount || isNaN(amount)) {
      toast('请输入有效金额', 'error');
      return;
    }
    try {
      await api.post(`/admin/users/${rechargeModal.id}/adjust`, { amount });
      toast(amount >= 0 ? `成功增加余额 $${amount.toFixed(2)}` : `成功扣减余额 $${Math.abs(amount).toFixed(2)}`);
      setRechargeModal(null);
      load();
    } catch (err) { toast(err.response?.data?.error?.message || '操作失败', 'error'); }
  };

  const openConcurrencyModal = (user) => {
    setConcurrencyValue(String(user.concurrent_limit || 3));
    setConcurrencyModal(user);
  };

  const handleConcurrencySave = async () => {
    const limit = parseInt(concurrencyValue);
    if (!limit || limit < 1 || limit > 100) {
      toast('并发数需在 1-100 之间', 'error');
      return;
    }
    try {
      await api.put(`/admin/users/${concurrencyModal.id}/concurrency`, { limit });
      toast('并发上限已更新');
      setConcurrencyModal(null);
      load();
    } catch (err) { toast(err.response?.data?.error?.message || '操作失败', 'error'); }
  };

  const openRpmModal = (user) => {
    setRpmValue(String(user.rpm_limit || 120));
    setRpmModal(user);
  };

  const handleRpmSave = async () => {
    const rpm = parseInt(rpmValue);
    if (!rpm || rpm < 1 || rpm > 1000) {
      toast('RPM 需在 1-1000 之间', 'error');
      return;
    }
    try {
      await api.put(`/admin/users/${rpmModal.id}/rpm`, { rpm });
      toast('RPM 限制已更新');
      setRpmModal(null);
      load();
    } catch (err) { toast(err.response?.data?.error?.message || '操作失败', 'error'); }
  };

  const handleToggleStatus = async (userId, currentActive) => {
    try {
      await api.put(`/admin/users/${userId}/status`, { isActive: !currentActive });
      toast('状态已更新');
      load();
    } catch (err) { toast('操作失败', 'error'); }
  };

  return (
    <div>
      <h2 className="text-2xl font-bold text-slate-800 mb-6">用户管理</h2>

      <div className="mb-4">
        <input
          className="border rounded-lg px-4 py-2 w-64"
          placeholder="搜索用户名或邮箱..."
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
        />
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">ID</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">用户名</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">邮箱</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">角色</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">余额</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">并发</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">RPM</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">状态</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">操作</th>
            </tr>
          </thead>
          <tbody>
            {users.list.map(u => (
              <tr key={u.id} className="border-t">
                <td className="px-4 py-3 text-sm">{u.id}</td>
                <td className="px-4 py-3 font-medium">{u.username}</td>
                <td className="px-4 py-3 text-sm text-slate-500">{u.email || '-'}</td>
                <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded text-xs ${u.role === 'superadmin' ? 'bg-purple-100 text-purple-700' : u.role === 'admin' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>{u.role}</span></td>
                <td className="px-4 py-3 font-mono text-sm">${parseFloat(u.balance).toFixed(4)}</td>
                <td className="px-4 py-3">
                  <button onClick={() => openConcurrencyModal(u)} className="text-sm text-primary-600 hover:underline" title="点击设置并发上限">
                    {u.concurrent_limit || 3}
                  </button>
                </td>
                <td className="px-4 py-3">
                  <button onClick={() => openRpmModal(u)} className="text-sm text-primary-600 hover:underline" title="点击设置每分钟请求数上限">
                    {u.rpm_limit ? `${u.rpm_limit}/分` : '默认 120/分'}
                  </button>
                </td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded text-xs ${u.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                    {u.is_active ? '正常' : '禁用'}
                  </span>
                </td>
                <td className="px-4 py-3 space-x-2">
                  <button onClick={() => openRechargeModal(u)} className="text-emerald-600 hover:underline text-sm">充值</button>
                  <button onClick={() => handleToggleStatus(u.id, u.is_active)} className="text-blue-600 hover:underline text-sm">
                    {u.is_active ? '禁用' : '启用'}
                  </button>
                </td>
              </tr>
            ))}
            {users.list.length === 0 && <tr><td colSpan="9" className="text-center py-8 text-slate-400">暂无用户</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="flex justify-between items-center mt-4">
        <span className="text-sm text-slate-500">共 {users.total} 个用户</span>
        <div className="space-x-2">
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="px-3 py-1 border rounded disabled:opacity-30">上一页</button>
          <span className="text-sm">{page} / {Math.ceil(users.total / 20) || 1}</span>
          <button disabled={page >= Math.ceil(users.total / 20)} onClick={() => setPage(p => p + 1)} className="px-3 py-1 border rounded disabled:opacity-30">下一页</button>
        </div>
      </div>

      {rechargeModal && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center overflow-y-auto p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-sm my-auto">
            <h3 className="text-lg font-bold mb-4">调整用户余额</h3>
            <p className="text-sm text-slate-500 mb-2">用户: {rechargeModal.username} (ID: {rechargeModal.id})</p>
            <p className="text-sm text-slate-500 mb-4">当前余额: ${parseFloat(rechargeModal.balance).toFixed(4)}</p>
            <input type="number" className="w-full border rounded-lg px-3 py-2 mb-2" placeholder="正数增加，负数扣减，如 10 或 -5" step="0.01" value={rechargeAmount} onChange={e => setRechargeAmount(e.target.value)} />
            <p className="text-xs text-slate-400 mb-4">正数为增加余额，负数为扣减余额，变动将记录流水</p>
            <div className="flex gap-3">
              <button onClick={() => setRechargeModal(null)} className="flex-1 py-2 border rounded-lg">取消</button>
              <button onClick={handleRecharge} className="flex-1 py-2 bg-emerald-600 text-white rounded-lg">确认调整</button>
            </div>
          </div>
        </div>
      )}

      {concurrencyModal && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center overflow-y-auto p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-sm my-auto">
            <h3 className="text-lg font-bold mb-4">设置并发上限</h3>
            <p className="text-sm text-slate-500 mb-4">用户: {concurrencyModal.username}，超出上限的并发请求将返回 429</p>
            <input type="number" min="1" max="100" className="w-full border rounded-lg px-3 py-2 mb-4" value={concurrencyValue} onChange={e => setConcurrencyValue(e.target.value)} />
            <div className="flex gap-3">
              <button onClick={() => setConcurrencyModal(null)} className="flex-1 py-2 border rounded-lg">取消</button>
              <button onClick={handleConcurrencySave} className="flex-1 py-2 bg-primary-600 text-white rounded-lg">保存</button>
            </div>
          </div>
        </div>
      )}

      {rpmModal && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center overflow-y-auto p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-sm my-auto">
            <h3 className="text-lg font-bold mb-4">设置 RPM 限制</h3>
            <p className="text-sm text-slate-500 mb-4">
              用户: {rpmModal.username}，每分钟可发起的代理请求数，超出将返回 429。
              与并发上限独立（并发控制同时进行的请求数）。
            </p>
            <input type="number" min="1" max="1000" className="w-full border rounded-lg px-3 py-2 mb-2" value={rpmValue} onChange={e => setRpmValue(e.target.value)} />
            <p className="text-xs text-slate-400 mb-4">范围 1-1000 次/分钟，系统默认 120</p>
            <div className="flex gap-3">
              <button onClick={() => setRpmModal(null)} className="flex-1 py-2 border rounded-lg">取消</button>
              <button onClick={handleRpmSave} className="flex-1 py-2 bg-primary-600 text-white rounded-lg">保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
