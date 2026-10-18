const nodemailer = require('nodemailer');
const { config } = require('../config');
const logger = require('../utils/logger');

let transporter = null;

/**
 * HTML 实体转义: 用户可控内容 (留言/用户名/上游错误信息)
 * 拼入管理员邮件前必须转义，防止 HTML 注入钓鱼 (伪造链接/表单)
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 获取邮件传输器 (懒初始化)
 */
function getTransporter() {
  if (transporter) return transporter;

  if (!config.smtp.host || !config.smtp.user) {
    logger.warn('邮件服务未配置，充值通知邮件将不会发送');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
  });

  return transporter;
}

/**
 * 发送充值请求通知给管理员
 * @param {Object} user - { id, username, email }
 * @param {number} amount - 请求充值金额
 * @param {string} message - 用户附加消息
 */
async function sendRechargeRequest(user, amount, message = '') {
  const transport = getTransporter();
  if (!transport) {
    logger.info('充值请求 (邮件未发送, SMTP 未配置)', { userId: user.id, amount });
    return false;
  }

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #3b82f6;">WildAPI - 充值请求</h2>
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr><td style="padding: 10px; border: 1px solid #e5e7eb; background: #f9fafb;"><strong>用户 ID</strong></td><td style="padding: 10px; border: 1px solid #e5e7eb;">${escapeHtml(user.id)}</td></tr>
        <tr><td style="padding: 10px; border: 1px solid #e5e7eb; background: #f9fafb;"><strong>用户名</strong></td><td style="padding: 10px; border: 1px solid #e5e7eb;">${escapeHtml(user.username)}</td></tr>
        <tr><td style="padding: 10px; border: 1px solid #e5e7eb; background: #f9fafb;"><strong>邮箱</strong></td><td style="padding: 10px; border: 1px solid #e5e7eb;">${escapeHtml(user.email || '未知')}</td></tr>
        <tr><td style="padding: 10px; border: 1px solid #e5e7eb; background: #f9fafb;"><strong>请求金额</strong></td><td style="padding: 10px; border: 1px solid #e5e7eb; color: #059669; font-size: 18px;"><strong>$${parseFloat(amount).toFixed(2)}</strong></td></tr>
      </table>
      ${message ? `<p style="margin: 20px 0; padding: 15px; background: #fef3c7; border-radius: 8px;"><strong>用户留言:</strong> ${escapeHtml(message)}</p>` : ''}
      <p style="color: #6b7280;">请登录 <a href="${escapeHtml(config.frontendUrl)}/admin/users" style="color: #3b82f6;">WildAPI 管理面板</a> 为该用户处理充值。</p>
    </div>
  `;

  try {
    await transport.sendMail({
      from: `"WildAPI" <${config.smtp.user}>`,
      to: config.adminEmail,
      subject: `[WildAPI] 用户 ${escapeHtml(user.username)} 申请充值 $${amount}`,
      html,
    });
    logger.info('充值请求邮件发送成功', { userId: user.id, amount });
    return true;
  } catch (err) {
    logger.error('充值请求邮件发送失败', { error: err.message, userId: user.id });
    return false;
  }
}

/**
 * 发送上游 API Key 失效告警给管理员
 * @param {Object} info - { providerName, keyName, keyMasked, status, reason, checkedAt }
 */
async function sendProviderKeyAlert({ providerName, keyName, keyMasked, status, reason, checkedAt }) {
  const transport = getTransporter();
  if (!transport) {
    logger.info('上游密钥告警 (邮件未发送, SMTP 未配置)', { providerName, keyMasked, status });
    return false;
  }

  const statusLabel = status === 'auth_failed' ? '密钥鉴权失效' : '服务不可达';
  const statusColor = status === 'auth_failed' ? '#dc2626' : '#d97706';

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #3b82f6;">WildAPI - 上游 API Key 告警</h2>
      <p style="color: #6b7280;">检测到上游密钥状态异常，请及时处理以保证服务可用性。</p>
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr><td style="padding: 10px; border: 1px solid #e5e7eb; background: #f9fafb;"><strong>服务商</strong></td><td style="padding: 10px; border: 1px solid #e5e7eb;">${escapeHtml(providerName)}</td></tr>
        <tr><td style="padding: 10px; border: 1px solid #e5e7eb; background: #f9fafb;"><strong>Key</strong></td><td style="padding: 10px; border: 1px solid #e5e7eb;">${escapeHtml(keyName ? `${keyName} (${keyMasked})` : keyMasked)}</td></tr>
        <tr><td style="padding: 10px; border: 1px solid #e5e7eb; background: #f9fafb;"><strong>状态</strong></td><td style="padding: 10px; border: 1px solid #e5e7eb; color: ${statusColor};"><strong>${statusLabel}</strong></td></tr>
        <tr><td style="padding: 10px; border: 1px solid #e5e7eb; background: #f9fafb;"><strong>原因</strong></td><td style="padding: 10px; border: 1px solid #e5e7eb;">${escapeHtml(reason)}</td></tr>
        <tr><td style="padding: 10px; border: 1px solid #e5e7eb; background: #f9fafb;"><strong>检测时间</strong></td><td style="padding: 10px; border: 1px solid #e5e7eb;">${escapeHtml(checkedAt)}</td></tr>
      </table>
      <p style="color: #6b7280;">请登录 <a href="${config.frontendUrl}/admin/providers" style="color: #3b82f6;">WildAPI 管理面板</a> 检查并更换密钥。同类告警 6 小时内不会重复发送。</p>
    </div>
  `;

  try {
    await transport.sendMail({
      from: `"WildAPI 监控" <${config.smtp.user}>`,
      to: config.adminEmail,
      subject: `[WildAPI] 上游 Key 告警: ${escapeHtml(providerName)} ${statusLabel}`,
      html,
    });
    logger.info('上游密钥告警邮件发送成功', { providerName, keyMasked, status });
    return true;
  } catch (err) {
    logger.error('上游密钥告警邮件发送失败', { error: err.message });
    return false;
  }
}

module.exports = { sendRechargeRequest, sendProviderKeyAlert };
