import { useState, useEffect } from 'react';
import api from '../../services/api';
import { toast } from '../../components/ui/Toast';

export default function Admins() {
  const [list, setList] = useState([]);

  const load = () => {
    api.get('/admin/admins').then(r => setList(r.data.data.list)).catch((err) => toast(err.response?.data?.error?.message || '加载失败', 'error'));
  };

  useEffect(() => { load(); }, []);

  const handleRevoke = async (user) => {
    if (!confirm(`确定撤销 ${user.username} 的管理员身份？其刷新后立即丧失管理面板访问权。`)) return;
    try {
      await api.put(`/admin/admins/${user.id}/role`, { role: 'user' });
      toast(`已撤销 ${user.username} 的管理员身份`);
      load();
    } catch (err) { toast(err.response?.data?.error?.message || '操作失败', 'error'); }
  };

  const handleRestore = async (user) => {
    try {
      await api.put(`/admin/admins/${user.id}/role`, { role: 'admin' });
      toast(`已恢复 ${user.username} 的管理员身份`);
      load();
    } catch (err) { toast(err.response?.data?.error?.message || '操作失败', 'error'); }
  };

  const handleToggleActive = async (user) => {
    try {
      await api.put(`/admin/admins/${user.id}/status`, { isActive: !user.is_active });
      toast('状态已更新');
      load();
    } catch (err) { toast('操作失败', 'error'); }
  };

  return (
    <div>
      <h2 className="text-2xl font-bold text-slate-800 mb-2">管理员权限管理</h2>
      <p className="text-sm text-slate-500 mb-6">仅超级管理员可见。撤销管理员身份后，对方刷新页面立即丧失管理面板访问权。</p>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">ID</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">用户名</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">邮箱</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">角色</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">状态</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map(u => (
              <tr key={u.id} className="border-t">
                <td className="px-4 py-3 text-sm">{u.id}</td>
                <td className="px-4 py-3 font-medium">{u.username}</td>
                <td className="px-4 py-3 text-sm text-slate-500">{u.email || '-'}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded text-xs ${u.role === 'superadmin' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                    {u.role}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded text-xs ${u.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                    {u.is_active ? '正常' : '停用'}
                  </span>
                </td>
                <td className="px-4 py-3 space-x-2">
                  {u.role === 'superadmin' ? (
                    <span className="text-xs text-slate-400">不可操作</span>
                  ) : (
                    <>
                      {u.role === 'admin' && (
                        <button onClick={() => handleRevoke(u)} className="text-red-600 hover:underline text-sm">撤销管理员</button>
                      )}
                      {u.role === 'user' && (
                        <button onClick={() => handleRestore(u)} className="text-blue-600 hover:underline text-sm">恢复管理员</button>
                      )}
                      <button onClick={() => handleToggleActive(u)} className="text-amber-600 hover:underline text-sm">
                        {u.is_active ? '停用' : '启用'}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan="6" className="text-center py-8 text-slate-400">暂无管理员</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
