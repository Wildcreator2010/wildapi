const jwt = require('jsonwebtoken');
const { config } = require('../config');

/**
 * 签发本地 JWT (固定 HS256，验证时锁定算法白名单作为纵深防御)
 * @param {Object} payload - { userId, username, role }
 * @returns {string} JWT token
 */
function signToken(payload) {
  return jwt.sign(payload, config.jwt.secret, {
    algorithm: 'HS256',
    expiresIn: config.jwt.expiresIn,
  });
}

/**
 * 验证 JWT (显式锁定算法，防止算法降级/混淆类攻击)
 * @param {string} token
 * @returns {Object} 解码后的 payload
 */
function verifyToken(token) {
  return jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
}

module.exports = { signToken, verifyToken };
