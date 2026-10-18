import { create } from 'zustand';
import api from '../services/api';

/** 安全解析 localStorage 的 JSON，损坏时返回 fallback 并清理 */
function safeParse(raw, fallback = null) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    // 损坏数据清理，防止模块初始化时崩溃导致白屏
    try { localStorage.removeItem('user'); localStorage.removeItem('token'); } catch {}
    return fallback;
  }
}

const ADMIN_ROLES = ['admin', 'superadmin'];

/** 本地 JWT 的过期时间戳 (毫秒); 解不出或无 exp 返回 null */
function tokenExpiresAt(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return json.exp ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
}

/** 登录/会话恢复后该去哪个面板 */
export function defaultTargetFor(user) {
  return user && ADMIN_ROLES.includes(user.role) ? '/admin/dashboard' : '/user/dashboard';
}

/**
 * 启动时的初始会话。
 * token 只存在于 localStorage 不等于会话有效: JWT 默认 24h 过期，
 * 过去 isAuthenticated 仅看 token 在不在，过期后每次进站都要先把整个面板画出来、
 * 再被接口 401 打回登录页。这里先本地判一次 exp，过期就当未登录。
 */
function readInitialSession() {
  const token = localStorage.getItem('token');
  if (!token) return { token: null, user: null, isAuthenticated: false };
  const exp = tokenExpiresAt(token);
  if (exp !== null && exp <= Date.now()) {
    clearSession();
    return { token: null, user: null, isAuthenticated: false };
  }
  return { token, user: safeParse(localStorage.getItem('user')), isAuthenticated: true };
}

const useAuthStore = create((set) => ({
  ...readInitialSession(),
  sessionChecked: false, // 会话是否已通过 /api/auth/me 验证

  login: (token, user) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    set({ token, user, isAuthenticated: true, sessionChecked: true });
  },

  logout: () => {
    clearSession();
    set({ token: null, user: null, isAuthenticated: false, sessionChecked: true });
  },

  /** 启动时用 /api/auth/me 校验本地会话，失败自动登出 */
  restoreSession: async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      set({ sessionChecked: true });
      return null;
    }
    try {
      const res = await api.get('/auth/me');
      const user = res.data.data.user;
      localStorage.setItem('user', JSON.stringify(user));
      set({ token, user, isAuthenticated: true, sessionChecked: true });
      return user;
    } catch {
      // token 失效: 清除本地会话
      clearSession();
      set({ token: null, user: null, isAuthenticated: false, sessionChecked: true });
      return null;
    }
  },

  isAdmin: () => {
    const user = safeParse(localStorage.getItem('user'));
    return !!user && ADMIN_ROLES.includes(user.role);
  },
}));

export { ADMIN_ROLES };
export default useAuthStore;
