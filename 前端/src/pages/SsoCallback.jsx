import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import useAuthStore, { defaultTargetFor } from '../store/authStore';
import { verifySsoState } from '../services/ssoState';

export default function SsoCallback() {
  const navigate = useNavigate();
  const { login, isAuthenticated, user } = useAuthStore();
  const [error, setError] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('sso_code');
    const state = params.get('state');

    // 先清掉 URL 里的授权码与 state: 任何分支都不留残参，刷新才不会重复消费
    window.history.replaceState({}, '', window.location.pathname);

    // 已登录 (或标签页里已有会话) 时不再消费新授权码
    if (isAuthenticated) {
      navigate(defaultTargetFor(user), { replace: true });
      return;
    }

    // state 必须与本次标签页发起登录时写入的值一致，且只能用一次
    if (!verifySsoState(state)) {
      setError('登录校验未通过（state 不匹配或已过期），请回到登录页重新登录');
      return;
    }

    if (!code) {
      setError('缺少授权码，请重新登录');
      return;
    }

    api.post('/sso/exchange', { code })
      .then(res => {
        const { token, user: loggedUser } = res.data.data;
        login(token, loggedUser);
        navigate(defaultTargetFor(loggedUser), { replace: true });
      })
      .catch(err => {
        const msg = err.response?.data?.error?.message || err.message;
        setError(msg);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="bg-white rounded-xl shadow-lg p-8 max-w-md text-center">
          <h2 className="text-xl font-semibold mb-2">登录失败</h2>
          <p className="text-red-500 mb-4">{error}</p>
          <button onClick={() => navigate('/login')} className="text-primary-600 hover:underline">
            重新登录
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <div className="animate-spin w-10 h-10 border-4 border-primary-500 border-t-transparent rounded-full mx-auto mb-4" />
        <p className="text-lg text-slate-600">正在验证身份...</p>
      </div>
    </div>
  );
}
