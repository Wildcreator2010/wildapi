import { Navigate } from 'react-router-dom';
import useAuthStore, { ADMIN_ROLES } from '../../store/authStore';

export default function ProtectedRoute({ children, adminOnly = false }) {
  const { isAuthenticated, user, sessionChecked } = useAuthStore();

  // 会话校验完成前不渲染: 否则深链 /admin/* 会先用 localStorage 里的旧 user 画出整个管理台，
  // 被撤销权限的管理员会在这一往返里看到活的管理界面 + 一串 401/403 toast
  if (!sessionChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-gray-500">
        正在校验登录状态...
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // user 为 null (localStorage 数据损坏) 时同样要拦住，不能因为取不到 role 就跳过管理员检查
  if (adminOnly && !ADMIN_ROLES.includes(user?.role)) {
    return <Navigate to="/unauthorized" replace />;
  }

  return children;
}
