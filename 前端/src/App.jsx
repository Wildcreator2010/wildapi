import { Routes, Route, Navigate } from 'react-router-dom';
import { useEffect } from 'react';
import { ToastContainer } from './components/ui/Toast';
import ProtectedRoute from './components/auth/ProtectedRoute';
import AdminLayout from './components/layout/AdminLayout';
import UserLayout from './components/layout/UserLayout';
import useAuthStore from './store/authStore';

// 页面
import Login from './pages/Login';
import SsoCallback from './pages/SsoCallback';
import Unauthorized from './pages/Unauthorized';
import AdminDashboard from './pages/admin/Dashboard';
import Providers from './pages/admin/Providers';
import Users from './pages/admin/Users';
import Logs from './pages/admin/Logs';
import Stats from './pages/admin/Stats';
import Settings from './pages/admin/Settings';
import Backup from './pages/admin/Backup';
import Pricing from './pages/admin/Pricing';
import Admins from './pages/admin/Admins';
import UserDashboard from './pages/user/Dashboard';
import ApiKeys from './pages/user/ApiKeys';
import UsageHistory from './pages/user/UsageHistory';
import Models from './pages/user/Models';
import Transactions from './pages/user/Transactions';
import Recharge from './pages/user/Recharge';

export default function App() {
  const restoreSession = useAuthStore((s) => s.restoreSession);
  const sessionChecked = useAuthStore((s) => s.sessionChecked);

  // 启动时验证本地会话 (token 失效自动登出，避免面板白屏/闪跳)
  useEffect(() => {
    if (!sessionChecked) {
      restoreSession().catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <ToastContainer />
      <Routes>
        {/* 公共路由 */}
        <Route path="/login" element={<Login />} />
        <Route path="/sso-callback" element={<SsoCallback />} />
        <Route path="/unauthorized" element={<Unauthorized />} />

        {/* 管理面板 (需 admin 角色) */}
        <Route path="/admin" element={
          <ProtectedRoute adminOnly><AdminLayout /></ProtectedRoute>
        }>
          <Route index element={<Navigate to="/admin/dashboard" replace />} />
          <Route path="dashboard" element={<AdminDashboard />} />
          <Route path="providers" element={<Providers />} />
          <Route path="users" element={<Users />} />
          <Route path="logs" element={<Logs />} />
          <Route path="stats" element={<Stats />} />
          <Route path="settings" element={<Settings />} />
          <Route path="backup" element={<Backup />} />
          <Route path="pricing" element={<Pricing />} />
          <Route path="admins" element={<Admins />} />
        </Route>

        {/* 用户面板 (需登录, 管理员也可访问个人使用区) */}
        <Route path="/user" element={
          <ProtectedRoute><UserLayout /></ProtectedRoute>
        }>
          <Route index element={<Navigate to="/user/dashboard" replace />} />
          <Route path="dashboard" element={<UserDashboard />} />
          <Route path="keys" element={<ApiKeys />} />
          <Route path="usage" element={<UsageHistory />} />
          <Route path="models" element={<Models />} />
          <Route path="transactions" element={<Transactions />} />
          <Route path="recharge" element={<Recharge />} />
        </Route>

        {/* 默认路由 */}
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </>
  );
}
