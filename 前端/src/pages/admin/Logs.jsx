import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../services/api';
import { toast } from '../../components/ui/Toast';

export default function Logs() {
  const [logs, setLogs] = useState({ list: [], total: 0 });
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ search: '', model: '', statusCode: '', userId: '' });
  const [detail, setDetail] = useState(null);
  const seqRef = useRef(0);

  const load = useCallback(() => {
    const params = { page, pageSize: 20, ...filters };
    Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
    const seq = ++seqRef.current;
    api.get('/admin/logs', { params }).then(r => {
      // 边打字边查时，先发出去的慢响应会覆盖后发的，表格显示早已改掉的筛选条件
      if (seq === seqRef.current) setLogs(r.data.data);
    }).catch((err) => toast(err.response?.data?.error?.message || '加载失败', 'error'));
  }, [page, filters]);

  useEffect(() => {
    // 300ms 防抖: 输入过程中不必每次按键都打一次列表接口
    const t = setTimeout(load, 300);
    const poll = setInterval(load, 10000); // 日志页保持 10 秒自动刷新
    return () => { clearTimeout(t); clearInterval(poll); };
  }, [load]);

  const showDetail = (id) => {
    api.get(`/admin/logs/${id}`).then(r => setDetail(r.data.data.log)).catch((err) => toast(err.response?.data?.error?.message || '加载失败', 'error'));
  };

  return (
    <div>
      <h2 className="text-2xl font-bold text-slate-800 mb-6">请求日志</h2>

      <div className="flex gap-3 mb-4 flex-wrap">
        <input className="border rounded-lg px-3 py-2 w-48" placeholder="搜索..." value={filters.search} onChange={e => { setFilters({...filters, search: e.target.value}); setPage(1); }} />
        <input className="border rounded-lg px-3 py-2 w-32" placeholder="模型" value={filters.model} onChange={e => { setFilters({...filters, model: e.target.value}); setPage(1); }} />
        <input className="border rounded-lg px-3 py-2 w-24" placeholder="状态码" value={filters.statusCode} onChange={e => { setFilters({...filters, statusCode: e.target.value}); setPage(1); }} />
        <button onClick={() => { setFilters({ search: '', model: '', statusCode: '', userId: '' }); setPage(1); }} className="px-3 py-2 border rounded-lg text-sm">重置</button>
        <span className="text-sm text-slate-400 self-center ml-auto">自动刷新 (10s)</span>
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-3 py-2">时间</th><th className="text-left px-3 py-2">用户</th><th className="text-left px-3 py-2">模型</th>
              <th className="text-left px-3 py-2">状态码</th><th className="text-left px-3 py-2">延迟</th><th className="text-left px-3 py-2">Token</th>
              <th className="text-left px-3 py-2">费用</th><th className="text-left px-3 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {logs.list.map(l => (
              <tr key={l.id} className={`border-t ${l.status_code && l.status_code >= 400 ? 'bg-red-50' : ''}`}>
                <td className="px-3 py-2 text-xs">{new Date(l.created_at).toLocaleString()}</td>
                <td className="px-3 py-2">{l.user_name || '-'}</td>
                <td className="px-3 py-2 font-mono text-xs">{l.model}</td>
                <td className="px-3 py-2">
                  <span className={`px-1.5 py-0.5 rounded text-xs font-mono ${l.status_code < 300 ? 'bg-emerald-100 text-emerald-700' : l.status_code < 500 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                    {l.status_code || '-'}
                  </span>
                </td>
                <td className="px-3 py-2">{l.latency_ms}ms</td>
                <td className="px-3 py-2 font-mono text-xs">{(l.tokens_in || 0) + (l.tokens_out || 0)}</td>
                <td className="px-3 py-2 font-mono text-xs">${parseFloat(l.cost || 0).toFixed(4)}</td>
                <td className="px-3 py-2">
                  <button onClick={() => showDetail(l.id)} className="text-primary-600 hover:underline text-xs">详情</button>
                </td>
              </tr>
            ))}
            {logs.list.length === 0 && <tr><td colSpan="8" className="text-center py-8 text-slate-400">暂无日志</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="flex justify-between mt-4">
        <span className="text-sm text-slate-500">共 {logs.total} 条</span>
        <div className="space-x-2">
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="px-3 py-1 border rounded disabled:opacity-30">上一页</button>
          <button disabled={page >= Math.ceil(logs.total / 20)} onClick={() => setPage(p => p + 1)} className="px-3 py-1 border rounded disabled:opacity-30">下一页</button>
        </div>
      </div>

      {detail && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center overflow-y-auto p-4 z-50" onClick={() => setDetail(null)}>
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[calc(100vh-2rem)] overflow-y-auto my-auto" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold mb-4">日志详情 #{detail.id}</h3>
            <div className="space-y-2 text-sm">
              <div><strong>模型:</strong> {detail.model}</div>
              <div><strong>延迟:</strong> {detail.latency_ms}ms</div>
              <div><strong>Token:</strong> 输入 {detail.tokens_in} + 输出 {detail.tokens_out}</div>
              <div><strong>费用:</strong> ${parseFloat(detail.cost).toFixed(6)}</div>
              {detail.error_message && <div className="text-red-600"><strong>错误:</strong> {detail.error_message}</div>}
              <details><summary className="cursor-pointer font-medium">请求体</summary>
                <pre className="bg-gray-100 p-3 rounded text-xs mt-2 overflow-auto max-h-48">{detail.request_body ? JSON.stringify(JSON.parse(detail.request_body), null, 2) : '无'}</pre>
              </details>
              <details><summary className="cursor-pointer font-medium">响应体</summary>
                <pre className="bg-gray-100 p-3 rounded text-xs mt-2 overflow-auto max-h-48">{detail.response_body ? (typeof detail.response_body === 'string' ? detail.response_body : JSON.stringify(detail.response_body, null, 2)) : '无'}</pre>
              </details>
            </div>
            <button onClick={() => setDetail(null)} className="mt-4 px-4 py-2 bg-gray-200 rounded-lg">关闭</button>
          </div>
        </div>
      )}
    </div>
  );
}
