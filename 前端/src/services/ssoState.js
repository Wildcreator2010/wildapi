const STATE_KEY = 'sso_state';

/**
 * 发起登录时生成一次性 state 并留在 sessionStorage。
 * 回调页必须原样取回才算这次登录是自己发起的 —— 认证中心只校验 redirect_uri 前缀，
 * 授权码本身不会绑会话：少了这一步，任何人拿到/粘贴一个 sso_code 到 /sso-callback
 * 就能换成那个账号的登录态 (CSRF)。
 */
export function createSsoState() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const state = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  sessionStorage.setItem(STATE_KEY, state);
  return state;
}

/** 校验并一次性消费 (无论成败都清除，防重放) */
export function verifySsoState(state) {
  const expected = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(STATE_KEY);
  return !!expected && !!state && state === expected;
}
