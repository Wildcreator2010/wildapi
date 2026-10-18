import { Link } from 'react-router-dom';
import useAuthStore, { ADMIN_ROLES } from '../store/authStore';

export default function Unauthorized() {
  const { user, isAuthenticated } = useAuthStore();
  // "/" 会被重定向到 /login，未登录用户点"返回首页"会被弹去登录页；
  // 已登录时应该回到自己能用的一面板
  const home = !isAuthenticated ? '/login'
    : (ADMIN_ROLES.includes(user?.role) ? '/admin/dashboard' : '/user/dashboard');

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-slate-800 mb-2">权限不足</h1>
        <p className="text-slate-500 mb-6">您没有访问此页面的权限</p>
        <Link to={home} className="text-primary-600 hover:underline">
          返回可用页面
        </Link>
      </div>
    </div>
  );
}
