import { useState, useEffect } from 'react';
import { LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import api from '../../services/api';
import { toast } from '../../components/ui/Toast';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#f97316'];

export default function Stats() {
  const [byTime, setByTime] = useState([]);
  const [byModel, setByModel] = useState([]);
  const [byUser, setByUser] = useState([]);
  const [days, setDays] = useState(14);

  useEffect(() => {
    // alive 标记: 切换时间范围时旧请求的响应不能覆盖新范围的数据
    let alive = true;
    const apply = (setter) => (r) => { if (alive) setter(r.data.data.list); };
    const fail = (label) => () => { if (alive) toast(`${label}加载失败`, 'error'); };

    api.get('/admin/stats/by-time', { params: { days } }).then(apply(setByTime)).catch(fail('按时间统计'));
    api.get('/admin/stats/by-model', { params: { days } }).then(apply(setByModel)).catch(fail('按模型统计'));
    api.get('/admin/stats/by-user', { params: { days, limit: 10 } }).then(apply(setByUser)).catch(fail('按用户统计'));
    return () => { alive = false; };
  }, [days]);

  return (
    <div>
      <h2 className="text-2xl font-bold text-slate-800 mb-6">用量统计</h2>

      <div className="mb-4 flex items-center gap-3">
        <span className="text-sm text-slate-500">时间范围:</span>
        {[7, 14, 30, 90].map(d => (
          <button key={d} onClick={() => setDays(d)} className={`px-3 py-1 rounded text-sm ${days === d ? 'bg-primary-600 text-white' : 'bg-gray-100'}`}>{d} 天</button>
        ))}
      </div>

      <div className="space-y-6">
        <div className="bg-white rounded-xl shadow-sm border p-5">
          <h3 className="font-semibold mb-4">每日请求量趋势</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={byTime}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{fontSize: 12}} />
              <YAxis />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="request_count" stroke="#3b82f6" name="请求数" />
              <Line type="monotone" dataKey="total_cost" stroke="#10b981" name="费用($)" />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-xl shadow-sm border p-5">
            <h3 className="font-semibold mb-4">模型用量分布</h3>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie data={byModel} dataKey="total_cost" nameKey="model" cx="50%" cy="50%" outerRadius={100} label={({model}) => model?.substring(0, 15)}>
                  {byModel.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="bg-white rounded-xl shadow-sm border p-5">
            <h3 className="font-semibold mb-4">用户用量 Top 10</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={byUser} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" />
                <YAxis type="category" dataKey="username" width={80} tick={{fontSize: 12}} />
                <Tooltip />
                <Bar dataKey="total_cost" fill="#3b82f6" name="费用($)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
