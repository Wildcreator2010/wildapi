import { useEffect, useRef } from 'react';

const WALLPAPER_URL = 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=1920&q=80';

/**
 * 全局面板背景 (wildcreator.top 同款): 壁纸 + 鼠标视差 + 径向暗角
 * 登录页/管理面板/用户面板统一使用
 */
export default function PanelBackground() {
  const bgRef = useRef(null);

  useEffect(() => {
    const bg = bgRef.current;
    if (!bg) return;
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

  return (
    <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none">
      <div
        ref={bgRef}
        className="absolute inset-0 will-change-transform"
        style={{
          backgroundImage: `linear-gradient(rgba(15, 23, 42, 0.55), rgba(15, 23, 42, 0.75)), url('${WALLPAPER_URL}')`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
        }}
      />
      <div
        className="absolute inset-0"
        style={{ background: 'radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.45) 100%)' }}
      />
    </div>
  );
}
