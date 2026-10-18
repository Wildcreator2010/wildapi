import { useState, useEffect } from 'react';
import api from '../../services/api';
import { toast } from '../../components/ui/Toast';

const TYPE_LABELS = {
  admin_recharge: { text: '管理员充值', cls: 'bg-emerald-100 text-emerald-700' },
  admin_adjust: { text: '余额调整', cls: 'bg-blue-100 text-blue-700' },
  api_consumption: { text: 'API 消费', cls: 'bg-orange-100 text-orange-700' },
  refund: { text: '退款', cls: 'bg-purple-100 text-purple-700' },
  initial: { text: '初始余额', cls: 'bg-gray-100 text-gray-600' },
};

export default function Transactions() {
  const [list, setList] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const load = (p = page) => {
    api.get(`/user/transactions?page=${p}&pageSize=${pageSize}`)
      .then(r => {
        setList(r.data.data.list);
        setTotal(r.data.data.total);
      })
      .catch((err) => toast(err.response?.data?.error?.message || '加载失败', 'error'));
  };

  useEffect(() => { load(page); }, [page]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-slate-800">余额明细</h2>
        <span className="text-sm text-slate-500">共 {total} 条记录</span>
      </div>

      <p className="text-sm text-slate-500 mb-4 -mt-2">
        充值、管理员调整与 API 调用消费均记录于此，金额正数为入账、负数为扣费。
      </p>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">时间</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">类型</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-slate-600">金额</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-slate-600">变动前</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-slate-600">变动后</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-600">备注</th>
            </tr>
          </thead>
          <tbody>
            {list.map(t => {
              const typeInfo = TYPE_LABELS[t.type] || { text: t.type, cls: 'bg-gray-100 text-gray-600' };
              const amount = parseFloat(t.amount);
              return (
                <tr key={t.id} className="border-t">
                  <td className="px-4 py-3 text-sm text-slate-500 whitespace-nowrap">
                    {t.created_at ? new Date(t.created_at).toLocaleString() : '-'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs ${typeInfo.cls}`}>{typeInfo.text}</span>
                  </td>
                  <td className={`px-4 py-3 text-right font-mono text-sm ${amount >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                    {amount >= 0 ? '+' : ''}{amount.toFixed(4)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-slate-400">
                    ${parseFloat(t.balance_before).toFixed(4)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-slate-500">
                    ${parseFloat(t.balance_after).toFixed(4)}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500 max-w-[240px] truncate" title={t.note || ''}>
                    {t.note || '-'}
                  </td>
                </tr>
              );
            })}
            {list.length === 0 && (
              <tr><td colSpan="6" className="text-center py-8 text-slate-400">暂无余额流水记录</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-4">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-3 py-1.5 border rounded-lg text-sm disabled:opacity-40"
          >上一页</button>
          <span className="text-sm text-slate-500">{page} / {totalPages}</span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="px-3 py-1.5 border rounded-lg text-sm disabled:opacity-40"
          >下一页</button>
        </div>
      )}
    </div>
  );
}
