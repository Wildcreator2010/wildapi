import { useState, useEffect } from 'react';
import api from '../../services/api';
import { toast } from '../../components/ui/Toast';

export default function ApiKeys() {
  const [keys, setKeys] = useState([]);
  const [maxKeys, setMaxKeys] = useState(20);
  const [activeCount, setActiveCount] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  // 一次性明文展示
  const [revealedKey, setRevealedKey] = useState(null);
  // 重命名弹窗
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  const load = () => {
    api.get('/user/keys').then(r => {
      setKeys(r.data.data.list);
      setMaxKeys(r.data.data.maxKeys);
      setActiveCount(r.data.data.activeCount);
    }).catch((err) => toast(err.response?.data?.error?.message || '加载失败', 'error'));
  };

  useEffect(() => { load(); }, []);

  const atLimit = activeCount >= maxKeys;

  const handleCreate = async () => {
    setCreating(true);
    try {
      const r = await api.post('/user/keys', { name: newName || null });
      const key = r.data.data.key;
      setRevealedKey(key.secret);
      setNewName('');
      setShowCreate(false);
      load();
    } catch (err) {
      toast(err.response?.data?.error?.message || '创建失败', 'error');
    } finally { setCreating(false); }
  };

  const copySecret = async () => {
    try {
      await navigator.clipboard.writeText(revealedKey);
      toast('已复制到剪贴板');
    } catch {
      // 降级方案
      const ta = document.createElement('textarea');
      ta.value = revealedKey;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      toast('已复制到剪贴板');
    }
  };

  const handleRename = async () => {
    try {
      await api.put(`/user/keys/${renameTarget.id}`, { name: renameValue });
      toast('已重命名');
      setRenameTarget(null);
      load();
    } catch (err) { toast('重命名失败', 'error'); }
  };

  const handleToggle = async (id) => {
    try {
      await api.put(`/user/keys/${id}/toggle`);
      load();
    } catch (err) { toast('操作失败', 'error'); }
  };

  const handleDelete = async (id) => {
    if (!confirm('确定删除此密钥？删除后立即失效，不可恢复。')) return;
    try {
      await api.delete(`/user/keys/${id}`);
      toast('密钥已删除并立即失效');
      load();
    } catch (err) { toast('删除失败', 'error'); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-slate-800">我的 API 密钥</h2>
        <button
          onClick={() => setShowCreate(true)}
          disabled={atLimit}
          className={`px-4 py-2 rounded-lg ${atLimit ? 'bg-gray-300 cursor-not-allowed text-gray-500' : 'bg-primary-600 text-white hover:bg-primary-700'}`}
        >
          {atLimit ? `已达上限 (${maxKeys})` : '+ 创建密钥'}
        </button>
      </div>

      <p className="text-sm text-slate-500 mb-4 -mt-2">
        密钥以 <code className="bg-gray-100 px-1 rounded">ak-</code> 开头，用于调用 OpenAI 兼容 API。明文仅在创建时展示一次，请妥善保存。
        当前 {activeCount}/{maxKeys} 个有效密钥。
      </p>

      {/* 一次性明文展示弹窗 */}
      {revealedKey && (
        <div className="fixed inset-0 bg-black/50 flex items-start justify-center overflow-y-auto p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-lg my-auto">
            <h3 className="font-bold text-lg mb-2">密钥创建成功</h3>
            <p className="text-sm text-red-600 mb-4">请立即复制保存！此密钥只显示这一次，关闭后无法再次查看。</p>
            <div className="flex gap-2 mb-4">
              <input readOnly value={revealedKey} className="flex-1 border rounded-lg px-3 py-2 font-mono text-sm bg-gray-50" />
              <button onClick={copySecret} className="px-4 py-2 bg-primary-600 text-white rounded-lg whitespace-nowrap">复制</button>
            </div>
            <div className="bg-gray-50 rounded-lg p-3 mb-4 text-xs text-slate-500 font-mono">
              调用示例:
              <pre className="mt-2 overflow-auto">{`curl https://api.wildcreator.top/v1/chat/completions \\
  -H "Authorization: Bearer ${revealedKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-3.5-turbo","messages":[{"role":"user","content":"Hello"}]}'`}</pre>
            </div>
            <button onClick={() => setRevealedKey(null)} className="w-full py-2 bg-gray-800 text-white rounded-lg">我已保存，关闭</button>
          </div>
        </div>
      )}

      {/* 创建弹窗 */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center overflow-y-auto p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-sm my-auto">
            <h3 className="font-bold mb-4">创建新密钥</h3>
            <input className="w-full border rounded-lg px-3 py-2 mb-4" placeholder="密钥名称 (可选，便于识别)" value={newName} onChange={e => setNewName(e.target.value)} maxLength={64} />
            <div className="flex gap-3">
              <button onClick={() => setShowCreate(false)} className="flex-1 py-2 border rounded-lg">取消</button>
              <button onClick={handleCreate} disabled={creating} className="flex-1 py-2 bg-emerald-600 text-white rounded-lg disabled:opacity-60">
                {creating ? '创建中...' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 重命名弹窗 */}
      {renameTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center overflow-y-auto p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-sm my-auto">
            <h3 className="font-bold mb-4">重命名密钥</h3>
            <input className="w-full border rounded-lg px-3 py-2 mb-4" value={renameValue} onChange={e => setRenameValue(e.target.value)} maxLength={64} />
            <div className="flex gap-3">
              <button onClick={() => setRenameTarget(null)} className="flex-1 py-2 border rounded-lg">取消</button>
              <button onClick={handleRename} className="flex-1 py-2 bg-primary-600 text-white rounded-lg">保存</button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">名称</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">密钥</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">最近使用</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">状态</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">操作</th>
            </tr>
          </thead>
          <tbody>
            {keys.map(k => (
              <tr key={k.id} className="border-t">
                <td className="px-4 py-3">{k.name || <span className="text-slate-400">未命名</span>}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-600">{k.masked}</td>
                <td className="px-4 py-3 text-sm text-slate-500">{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : '从未使用'}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded text-xs ${k.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                    {k.is_active ? '启用' : '禁用'}
                  </span>
                </td>
                <td className="px-4 py-3 space-x-2">
                  <button
                    onClick={() => { setRenameTarget(k); setRenameValue(k.name || ''); }}
                    className="text-blue-600 hover:underline text-sm"
                  >重命名</button>
                  <button onClick={() => handleToggle(k.id)} className="text-amber-600 hover:underline text-sm">
                    {k.is_active ? '禁用' : '启用'}
                  </button>
                  <button onClick={() => handleDelete(k.id)} className="text-red-600 hover:underline text-sm">删除</button>
                </td>
              </tr>
            ))}
            {keys.length === 0 && (
              <tr><td colSpan="5" className="text-center py-8 text-slate-400">
                暂无密钥，点击右上角「创建密钥」生成你的专属代理 Key
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
