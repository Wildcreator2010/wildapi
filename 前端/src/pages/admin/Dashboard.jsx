import { useState, useEffect } from 'react';
import api from '../../services/api';
import { toast } from '../../components/ui/Toast';
import {
  IconUsers, IconPlug, IconLogs, IconCalendar, IconWallet, IconChart, IconLayers, IconKey,
} from '../../components/ui/Icons';

export default function AdminDashboard() {
  const [stats, setStats] = useState(null);
  const [hitrate, setHitrate] = useState(null);

  useEffect(() => {
    api.get('/admin/stats/overview').then(r => setStats(r.data.data)).catch((err) => toast(err.response?.data?.error?.message || '加载失败', 'error'));
    api.get('/admin/stats/by-hitrate').then(r => setHitrate(r.data.data)).catch((err) => toast(err.response?.data?.error?.message || '加载失败', 'error'));
  }, []);

  const cards = [
    { label: '总用户', value: stats?.userCount ?? '-', Icon: IconUsers },
    { label: '活跃用户', value: stats?.activeUserCount ?? '-', Icon: IconUsers },
    { label: '上游服务商', value: stats?.providerCount ?? '-', Icon: IconPlug },
    { label: '总请求数', value: stats?.totalRequests ?? '-', Icon: IconLogs },
    { label: '今日请求', value: stats?.todayRequests ?? '-', Icon: IconCalendar },
    { label: '总消费', value: stats?.totalCost ? `$${stats.totalCost.toFixed(2)}` : '-', Icon: IconWallet },
    { label: '平均延迟', value: stats?.avgLatencyMs ? `${stats.avgLatencyMs}ms` : '-', Icon: IconChart },
    { label: '用户总余额', value: stats?.totalBalance ? `$${stats.totalBalance.toFixed(2)}` : '-', Icon: IconWallet },
  ];

  const hitCards = [
    {
      // Redis 计数器从不清零，标注"累计"而不是让人误读成近 N 天
      label: '代理密钥缓存命中率 (累计)',
      value: hitrate?.cacheHitRate?.rate != null ? `${hitrate.cacheHitRate.rate}%` : '-',
      sub: hitrate?.cacheHitRate?.totalCount == null ? 'Redis 不可用'
        : (hitrate?.cacheHitRate ? `${hitrate.cacheHitRate.hitCount} / ${hitrate.cacheHitRate.totalCount} 次` : '暂无数据'),
      Icon: IconKey,
    },
    {
      label: '模型路由命中率 (累计)',
      value: hitrate?.routeHitRate?.rate != null ? `${hitrate.routeHitRate.rate}%` : '-',
      sub: hitrate?.routeHitRate?.totalCount == null ? 'Redis 不可用'
        : (hitrate?.routeHitRate ? `${hitrate.routeHitRate.hitCount} / ${hitrate.routeHitRate.totalCount} 次` : '暂无数据'),
      Icon: IconLayers,
    },
  ];

  return (
    <div>
      <h2 className="text-2xl font-bold text-white mb-1" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.5)' }}>管理总览</h2>
      <p className="text-sm text-white/60 mb-6" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.4)' }}>
        系统运行概况与核心指标
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {cards.map((c, i) => (
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

      <h3 className="text-lg font-semibold text-white mb-4" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.5)' }}>命中率</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {hitCards.map((c, i) => (
          <div
            key={i}
            className="p-5 flex items-center gap-4"
            style={{
              background: 'rgba(255, 255, 255, 0.08)',
              backdropFilter: 'blur(20px) saturate(1.8) brightness(1.1)',
              WebkitBackdropFilter: 'blur(20px) saturate(1.8) brightness(1.1)',
              border: '1px solid rgba(255, 255, 255, 0.25)',
              borderRadius: '20px',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.4), 0 8px 32px rgba(0,0,0,0.15)',
            }}
          >
            <div className="text-white/70"><c.Icon /></div>
            <div>
              <div className="text-xl font-bold text-white" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.4)' }}>{c.value}</div>
              <div className="text-sm text-white/70">{c.label}</div>
              <div className="text-xs text-white/50 mt-0.5">{c.sub}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
