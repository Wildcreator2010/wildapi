import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import useAuthStore, { defaultTargetFor } from '../store/authStore';
import { createSsoState } from '../services/ssoState';

const SSO_AUTH_URL = import.meta.env.VITE_SSO_AUTH_URL || 'https://login.wildcreator.top';
const SSO_CLIENT_ID = import.meta.env.VITE_SSO_CLIENT_ID || 'wildapi';
// 默认按当前站点推导回调地址: 构建期常量写死 localhost 会让线上登录跳回访问者自己的机器
const SSO_REDIRECT_URI = import.meta.env.VITE_SSO_REDIRECT_URI || `${window.location.origin}/sso-callback`;

// wildcreator.top 同款壁纸
const WALLPAPER_URL = 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=1920&q=80';

export default function Login() {
  const navigate = useNavigate();
  const { user, isAuthenticated, sessionChecked } = useAuthStore();
  const bgRef = useRef(null);
  const [redirecting, setRedirecting] = useState(false);

  // ---- wildcreator.top 同款鼠标视差效果 ----
  useEffect(() => {
    const bg = bgRef.current;
    if (!bg) return;

    // 触屏设备 / 减少动画偏好时禁用
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let rafId = null;
    const onMouseMove = (e) => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        const x = (e.clientX / window.innerWidth - 0.5) * 2;
        const y = (e.clientY / window.innerHeight - 0.5) * 2;
        bg.style.transform = `scale(1.06) translate(${-x * 10}px, ${-y * 10}px)`;
        rafId = null;
      });
    };

    window.addEventListener('mousemove', onMouseMove, { passive: true });
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []);

  // 已登录时跳转面板 (副作用放 effect, 避免渲染期 navigate 导致白屏)。
  // 等 sessionChecked 再跳: 否则拿着过期 token 也会被弹进面板又立刻弹出来。
  useEffect(() => {
    if (sessionChecked && isAuthenticated) {
      navigate(defaultTargetFor(user), { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionChecked, isAuthenticated]);

  const handleSsoLogin = () => {
    setRedirecting(true);
    const qs = new URLSearchParams({
      client_id: SSO_CLIENT_ID,
      redirect_uri: SSO_REDIRECT_URI,
      state: createSsoState(),
    });
    window.location.href = `${SSO_AUTH_URL}/authorize?${qs}`;
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden bg-[#2b3a4a]">
      {/* wildcreator.top 同款背景: 壁纸 + 视差 */}
      <div className="fixed inset-0 z-0 overflow-hidden">
        <div
          ref={bgRef}
          className="absolute inset-0 will-change-transform transition-transform duration-300 ease-out"
          style={{
            backgroundImage: `linear-gradient(rgba(0,0,0,0.1), rgba(0,0,0,0.1)), url('${WALLPAPER_URL}')`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
          }}
        />
        {/* 径向渐变遮罩 */}
        <div
          className="absolute inset-0"
          style={{ background: 'radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.5) 100%)' }}
        />
      </div>

      {/* 登录卡片 - Liquid Glass 毛玻璃 (wildcreator.top 规范) */}
      <div className="relative z-10 w-full max-w-md mx-4 sm:mx-6">
        <div
          className="p-8 sm:p-10 text-center"
          style={{
            background: 'rgba(255, 255, 255, 0.09)',
            backdropFilter: 'blur(20px) saturate(1.8) brightness(1.1)',
            WebkitBackdropFilter: 'blur(20px) saturate(1.8) brightness(1.1)',
            border: '1px solid rgba(255, 255, 255, 0.25)',
            borderRadius: '20px',
            boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.4), 0 8px 32px rgba(0, 0, 0, 0.15)',
          }}
        >
          <h1 className="text-3xl font-bold text-white mb-2" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.5)' }}>WildAPI</h1>
          <p className="text-white/80 mb-8 text-sm" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.4)' }}>AI API 中转服务平台</p>

          <button
            onClick={handleSsoLogin}
            disabled={redirecting}
            className="w-full py-3 px-6 bg-white/20 hover:bg-white/30 disabled:opacity-60 text-white font-medium rounded-xl transition-colors"
            style={{
              border: '1px solid rgba(255, 255, 255, 0.25)',
              textShadow: '0 1px 2px rgba(0,0,0,0.4)',
              boxShadow: '0 4px 16px rgba(0, 0, 0, 0.15)',
            }}
          >
            {redirecting ? '正在跳转登录...' : '通过 WildAccount 登录'}
          </button>

          <p className="mt-6 text-xs text-white/60" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.4)' }}>
            使用 WildAccount 统一账号登录，安全便捷
          </p>
        </div>
      </div>
    </div>
  );
}
