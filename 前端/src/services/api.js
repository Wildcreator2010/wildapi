import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

// 请求拦截器 - 注入 JWT
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 响应拦截器 - 处理 401
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      // 登录/回调页要自己把错误文案显示给用户 (换码失败本身就是 401)，
      // 在这里硬跳转会让 SsoCallback 的"登录失败"分支永远不可达，
      // 也会在 /login 上把用户弹回面板 (内存里 isAuthenticated 还是 true)
      const onAuthPage = ['/login', '/sso-callback'].includes(window.location.pathname);
      if (!onAuthPage) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export default api;
