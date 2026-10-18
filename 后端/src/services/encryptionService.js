const crypto = require('crypto');
const { config } = require('../config');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * 将 hex 编码的密钥转换为 Buffer
 * 如果环境变量中的密钥不是有效 hex，抛出明确错误
 */
function getKeyBuffer() {
  const key = config.encryption.key;
  if (!key || key.length !== 64) {
    throw new Error('ENCRYPTION_KEY 必须为 64 位十六进制字符串 (32 字节)');
  }
  return Buffer.from(key, 'hex');
}

/**
 * AES-256-GCM 加密
 * @param {string} plaintext - 明文
 * @returns {string} Base64 编码的密文 (格式: iv:tag:ciphertext)
 */
function encrypt(plaintext) {
  const key = getKeyBuffer();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const tag = cipher.getAuthTag();

  // 格式: iv(base64):tag(base64):ciphertext(base64)
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted}`;
}

/**
 * AES-256-GCM 解密
 * @param {string} encryptedData - encrypt() 的输出
 * @returns {string} 明文
 */
function decrypt(encryptedData) {
  const key = getKeyBuffer();
  const parts = encryptedData.split(':');
  if (parts.length !== 3) {
    throw new Error('密文格式无效');
  }

  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const ciphertext = parts[2];

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = { encrypt, decrypt };
