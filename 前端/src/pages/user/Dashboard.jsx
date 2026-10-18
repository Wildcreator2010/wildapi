import { useState, useEffect } from 'react';
import api from '../../services/api';
import { IconWallet, IconCalendar, IconLogs, IconKey, IconLayers } from '../../components/ui/Icons';
import { toast } from '../../components/ui/Toast';

export default function UserDashboard() {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get('/user/dashboard').then(r => setData(r.data.data)).catch((err) => toast(err.response?.data?.error?.message || '加载失败', 'error'));
  }, []);

  return (
    <div>
      <h2 className="text-2xl font-bold text-white mb-6" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.5)' }}>我的仪表盘</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        {[
          { label: '账户余额', value: data ? `$${data.balance.toFixed(4)}` : '-', Icon: IconWallet },
          { label: '今日请求', value: data?.today?.requests || '-', Icon: IconCalendar },
          { label: '本月请求', value: data?.month?.requests || '-', Icon: IconLogs },
          { label: 'API 密钥', value: data?.apiKeyCount || '-', Icon: IconKey },
          { label: '并发占用', value: data ? `${data.concurrency?.current || 0}/${data.concurrency?.limit || 3}` : '-', Icon: IconLayers },
        ].map((c, i) => (
          <div
            key={i}
            className="p-5"
            style={{
              background: 'rgba(255, 255, 255, 0.08)',
              backdropFilter: 'blur(20px) saturate(1.8) brightness(1.1)',
              WebkitBackdropFilter: 'blur(20px) saturate(1.8) brightness(1.1)',
              border: '1px solid rgba(255, 255, 255, 0.25)',
              borderRadius: '20px',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.4), 0 8px 32px rgba(0,0,0,0.15)',
            }}
          >
            <div className="text-white/70 mb-2"><c.Icon /></div>
            <div className="text-2xl font-bold text-white" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.4)' }}>{c.value}</div>
            <div className="text-sm text-white/70 mt-1">{c.label}</div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white/10 backdrop-blur border border-white/25 rounded-[20px] p-5">
          <h3 className="font-semibold mb-2 text-white">今日用量</h3>
          <div className="text-sm space-y-1 text-white/80">
            <p>Token: {(data?.today?.tokens || 0).toLocaleString()}</p>
            <p>费用: ${(data?.today?.cost || 0).toFixed(4)}</p>
          </div>
        </div>
        <div className="bg-white/10 backdrop-blur border border-white/25 rounded-[20px] p-5">
          <h3 className="font-semibold mb-2 text-white">本月用量</h3>
          <div className="text-sm space-y-1 text-white/80">
            <p>Token: {(data?.month?.tokens || 0).toLocaleString()}</p>
            <p>费用: ${(data?.month?.cost || 0).toFixed(4)}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
