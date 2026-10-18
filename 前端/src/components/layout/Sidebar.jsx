import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import useAuthStore, { ADMIN_ROLES } from '../../store/authStore';
import {
  IconHome, IconBrain, IconKey, IconHistory, IconDashboard, IconPlug,
  IconUsers, IconLogs, IconChart, IconSettings, IconPrice, IconBackup, IconShield, IconArrow, IconWallet,
} from '../ui/Icons';

const adminLinks = [
  { to: '/admin/dashboard', label: '管理总览', icon: IconDashboard },
  { to: '/user/models', label: '模型列表', icon: IconBrain },
  { to: '/admin/providers', label: '上游服务商', icon: IconPlug },
  { to: '/admin/users', label: '用户管理', icon: IconUsers },
  { to: '/admin/logs', label: '请求日志', icon: IconLogs },
  { to: '/admin/stats', label: '用量统计', icon: IconChart },
  { to: '/admin/settings', label: '系统设置', icon: IconSettings },
  { to: '/admin/pricing', label: '定价配置', icon: IconPrice },
  { to: '/admin/backup', label: '数据备份', icon: IconBackup },
];

// 仅 superadmin 可见
const superadminLinks = [
  { to: '/admin/admins', label: '权限管理', icon: IconShield },
];

// 管理员个人使用区 (与普通用户同等待遇: 自建 Key、调用扣费)
const adminPersonalLinks = [
  { to: '/user/dashboard', label: '我的仪表盘', icon: IconHome },
  { to: '/user/keys', label: '我的 API 密钥', icon: IconKey },
  { to: '/user/usage', label: '我的使用记录', icon: IconHistory },
  { to: '/user/transactions', label: '余额明细', icon: IconWallet },
];

// 仅 superadmin 可见 (个人充值)
const superadminPersonalLinks = [
  { to: '/user/recharge', label: '自助充值', icon: IconPrice },
];

const userLinks = [
  { to: '/user/dashboard', label: '仪表盘', icon: IconHome },
  { to: '/user/models', label: '模型列表', icon: IconBrain },
  { to: '/user/keys', label: 'API 密钥', icon: IconKey },
  { to: '/user/usage', label: '使用记录', icon: IconHistory },
];

export default function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const [collapsed, setCollapsed] = useState(false);

  const isAdmin = user && ADMIN_ROLES.includes(user.role);
  const isSuperadmin = user && user.role === 'superadmin';
  const links = isAdmin
    ? [
        ...adminLinks,
        ...(isSuperadmin ? superadminLinks : []),
        ...adminPersonalLinks,
        ...(isSuperadmin ? superadminPersonalLinks : []),
      ]
    : userLinks;

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <aside className={`${collapsed ? 'w-16' : 'w-60'} bg-slate-900/95 backdrop-blur text-slate-300 flex flex-col transition-all duration-200 min-h-screen border-r border-white/10`}>
      <div className="p-4 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <img src="/logo.png" alt="WildAPI" className="w-8 h-8 rounded-lg shrink-0 object-contain" />
          {!collapsed && <h1 className="text-lg font-bold text-white tracking-wide truncate">WildAPI</h1>}
        </div>
        <button onClick={() => setCollapsed(!collapsed)} className="text-slate-400 hover:text-white transition-colors" aria-label="折叠侧边栏">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
            {collapsed
              ? <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
              : <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />}
          </svg>
        </button>
      </div>

      <nav className="flex-1 py-4 space-y-1 overflow-y-auto">
        {links.map(link => {
          const Icon = link.icon;
          const active = location.pathname === link.to;
          return (
            <Link
              key={link.to}
              to={link.to}
              className={`flex items-center gap-3 px-4 py-2.5 mx-2 rounded-lg text-sm transition-colors ${
                active ? 'bg-white/15 text-white' : 'hover:bg-white/10 hover:text-white'
              }`}
            >
              <Icon />
              {!collapsed && <span>{link.label}</span>}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-white/10">
        {!collapsed && user && (
          <div className="text-xs mb-3">
            <div className="text-slate-400">{user.username}</div>
            <div className="text-blue-300">{user.role}</div>
          </div>
        )}
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 text-sm text-slate-400 hover:text-red-300 transition-colors w-full"
        >
          <IconArrow />
          {!collapsed && <span>退出登录</span>}
        </button>
      </div>
    </aside>
  );
}
