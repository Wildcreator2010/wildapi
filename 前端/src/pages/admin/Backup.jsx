import { useState, useEffect } from 'react';
import api from '../../services/api';
import { toast } from '../../components/ui/Toast';

export default function Backup() {
  const [backups, setBackups] = useState([]);
  const [backingUp, setBackingUp] = useState(false);

  const load = () => api.get('/admin/backup')
    .then(r => setBackups(r.data.data.list))
    .catch(err => toast(err.response?.data?.error?.message || '备份列表加载失败', 'error'));

  useEffect(() => { load(); }, []);

  const handleCreateBackup = async () => {
    setBackingUp(true);
    try {
      const r = await api.post('/admin/backup');
      toast(`备份成功: ${r.data.data.filename}`);
      load();
    } catch (err) { toast(err.response?.data?.error?.message || '备份失败', 'error'); }
    finally { setBackingUp(false); }
  };

  const handleDownload = async (filename) => {
    const token = localStorage.getItem('token');
    // 基址取自 api 实例: 硬编码 /api 会让 VITE_API_URL 指向独立域名的部署 404
    const url = `${api.defaults.baseURL}/admin/backup/${encodeURIComponent(filename)}/download`;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        // 401/token 过期时后端返回的是错误 JSON，直接存成 .sql 会得到一个"看着成功"的坏文件
        const detail = await res.json().catch(() => null);
        toast(detail?.error?.message || `下载失败 (HTTP ${res.status})`, 'error');
        return;
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(objectUrl);
    } catch {
      toast('下载失败，请检查网络或重新登录', 'error');
    }
  };

  const handleDelete = async (filename) => {
    if (!confirm(`确定删除备份 ${filename}？`)) return;
    try {
      await api.delete(`/admin/backup/${filename}`);
      toast('已删除');
      load();
    } catch (err) { toast('删除失败', 'error'); }
  };

  const handleRestore = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm(`确定要将数据库恢复到 ${file.name}？当前数据将被覆盖! 系统会自动创建安全备份。`)) {
      e.target.value = '';
      return;
    }
    const formData = new FormData();
    formData.append('backupFile', file);
    try {
      const r = await api.post('/admin/backup/restore', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 600000,
      });
      toast('数据库恢复成功!');
      load();
    } catch (err) { toast(err.response?.data?.error?.message || '恢复失败', 'error'); }
    e.target.value = '';
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-slate-800">数据备份与恢复</h2>
        <div className="flex gap-3">
          <label className="px-4 py-2 border rounded-lg cursor-pointer text-sm hover:bg-gray-50">
            上传恢复
            <input type="file" accept=".sql,.sql.gz" onChange={handleRestore} className="hidden" />
          </label>
          <button onClick={handleCreateBackup} disabled={backingUp} className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50">
            {backingUp ? '备份中...' : '立即备份'}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">文件名</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">大小</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">创建时间</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">操作</th>
            </tr>
          </thead>
          <tbody>
            {backups.map(b => (
              <tr key={b.filename} className="border-t">
                <td className="px-4 py-3 font-mono text-sm">{b.filename}</td>
                <td className="px-4 py-3">{b.sizeFormatted}</td>
                <td className="px-4 py-3 text-sm text-slate-500">{new Date(b.createdAt).toLocaleString()}</td>
                <td className="px-4 py-3 space-x-2">
                  <button onClick={() => handleDownload(b.filename)} className="text-primary-600 hover:underline text-sm">下载</button>
                  <button onClick={() => handleDelete(b.filename)} className="text-red-600 hover:underline text-sm">删除</button>
                </td>
              </tr>
            ))}
            {backups.length === 0 && (
              <tr><td colSpan="4" className="text-center py-12 text-slate-400">
                <p>暂无备份文件</p>
                <p className="text-xs mt-1">点击"立即备份"创建数据库完整备份</p>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-6 p-4 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
        <strong>注意:</strong> 恢复操作会覆盖当前数据库中的所有数据。系统会在恢复前自动创建一份安全备份以防万一。
      </div>
    </div>
  );
}
