import { useState, useEffect, useCallback } from 'react';

let toastId = 0;
const listeners = new Set();

function emitToast(toast) {
  listeners.forEach(fn => fn(toast));
}

export function toast(message, type = 'success') {
  const id = ++toastId;
  emitToast({ id, message, type });

  // 可选的全局 toast 容器处理
  setTimeout(() => {
    emitToast({ id, remove: true });
  }, 4000);
}

export function ToastContainer() {
  const [toasts, setToasts] = useState([]);

  const handleToast = useCallback((t) => {
    if (t.remove) {
      setToasts(prev => prev.filter(item => item.id !== t.id));
    } else {
      setToasts(prev => [...prev, t]);
    }
  }, []);

  useEffect(() => {
    listeners.add(handleToast);
    return () => listeners.delete(handleToast);
  }, [handleToast]);

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`toast-enter px-4 py-3 rounded-lg shadow-lg text-white text-sm ${
            t.type === 'success' ? 'bg-emerald-500' :
            t.type === 'error' ? 'bg-red-500' :
            t.type === 'warning' ? 'bg-amber-500' :
            'bg-blue-500'
          }`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
