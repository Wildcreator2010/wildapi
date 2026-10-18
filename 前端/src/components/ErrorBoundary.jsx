import { Component } from 'react';

/**
 * 全局错误边界: 捕获渲染期 JS 异常，防止白屏
 * 显示友好错误提示与重试按钮
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('应用渲染异常', error, info);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.href = '/login';
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#2b3a4a]">
          <div
            className="p-8 max-w-md w-full mx-4 text-center"
            style={{
              background: 'rgba(255, 255, 255, 0.09)',
              backdropFilter: 'blur(20px) saturate(1.8) brightness(1.1)',
              WebkitBackdropFilter: 'blur(20px) saturate(1.8) brightness(1.1)',
              border: '1px solid rgba(255, 255, 255, 0.25)',
              borderRadius: '20px',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.4), 0 8px 32px rgba(0,0,0,0.15)',
            }}
          >
            <h2 className="text-xl font-bold text-white mb-2" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.5)' }}>
              页面出错了
            </h2>
            <p className="text-white/70 text-sm mb-6" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.4)' }}>
              渲染过程中发生异常，点击下方按钮重新加载
            </p>
            <button
              onClick={this.handleReset}
              className="w-full py-2.5 px-6 bg-white/20 hover:bg-white/30 text-white rounded-xl"
              style={{ border: '1px solid rgba(255,255,255,0.25)' }}
            >
              返回登录页
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
