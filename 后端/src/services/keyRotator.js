const ProviderKey = require('../models/ProviderKey');
const RateLimitConfig = require('../models/RateLimitConfig');
const { redis } = require('../config/database');
const logger = require('../utils/logger');

/**
 * 密钥轮转器
 * 从密钥池中选择可用密钥，支持并发控制和冷却机制。
 * 并发计数用 Lua 脚本原子操作:
 *  - 占用: INCR + EXPIRE 单次往返，避免崩溃后计数永不过期;
 *  - 释放: 仅当 key 存在时 DECR，结果 <= 0 时删除，
 *    防止计数过期后释放把计数器打成负数永久残留导致并发超限。
 */
const ACQUIRE_SLOT_LUA = `
local v = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
return v
`;

const RELEASE_SLOT_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  local v = redis.call('DECR', KEYS[1])
  if v <= 0 then redis.call('DEL', KEYS[1]) end
  return v
end
return 0
`;

// 并发槽 TTL: 正常路径由 releaseKey 释放，TTL 仅作崩溃兜底；
// 取较长值以覆盖长流式请求 (超过 TTL 的极端请求仅短暂丢失槽位，不会永久损坏计数)
const SLOT_TTL_SECONDS = 300;

class KeyRotator {
  /**
   * 获取一把可用的密钥
   * @param {number} providerId
   * @returns {{ keyId: number, apiKey: string }} 密钥 ID 和解密后的 API key
   */
  async acquireKey(providerId) {
    const availableKeys = await ProviderKey.getAvailableKeys(providerId);
    if (availableKeys.length === 0) {
      throw new Error(`服务商 ${providerId} 没有可用的 API 密钥`);
    }

    const config = await RateLimitConfig.findByProviderId(providerId);
    const concurrencyLimit = config?.concurrent_limit || 10;

    let decryptFailures = 0;
    // 检查每把密钥的并发数，选一把可用的 (INCR+EXPIRE 原子)
    for (const key of availableKeys) {
      const concurrencyKey = `concurrency:key:${key.id}`;
      let current;
      let slotHeld = false;
      try {
        current = await redis.eval(ACQUIRE_SLOT_LUA, 1, concurrencyKey, SLOT_TTL_SECONDS);
        slotHeld = true;
      } catch (err) {
        // Redis 抖动不应伪装成"所有密钥均达到并发上限"把请求打死: 计数不可用时跳过槽位检查放行
        logger.warn('并发计数不可用，跳过槽位检查', { keyId: key.id, error: err.message });
        current = 0;
      }

      if (current <= concurrencyLimit) {
        try {
          const apiKey = await ProviderKey.getDecryptedKey(key.id);
          return { keyId: key.id, apiKey };
        } catch (err) {
          // 解密失败，释放并发槽 (安全释放，不产生负数)
          if (slotHeld) await this.releaseKey(key.id);
          decryptFailures++;
          logger.error('密钥解密失败', { keyId: key.id, error: err.message });
          continue;
        }
      }

      // 超出并发限制，释放 (安全释放，不产生负数)
      if (slotHeld) await this.releaseKey(key.id);
    }

    // 密钥都在但一把都解不开 = ENCRYPTION_KEY 与库内密文不匹配 (本地配置问题)，
    // 报成"并发上限"会误导排障并触发无谓的熔断
    if (decryptFailures > 0 && decryptFailures === availableKeys.length) {
      throw new Error(`服务商 ${providerId} 的 ${decryptFailures} 把密钥全部解密失败，请检查 ENCRYPTION_KEY 是否与入库时一致`);
    }
    throw new Error(`服务商 ${providerId} 所有密钥均达到并发上限`);
  }

  /**
   * 释放密钥的并发槽 (幂等安全: key 已过期时不产生负数残留)
   * Redis 不可用时静默跳过: 释放失败不应让已完成的请求被判为上游故障
   */
  async releaseKey(keyId) {
    const concurrencyKey = `concurrency:key:${keyId}`;
    try {
      await redis.eval(RELEASE_SLOT_LUA, 1, concurrencyKey);
    } catch (err) {
      logger.warn('并发槽释放失败 (Redis 不可用)', { keyId, error: err.message });
    }
  }

  /**
   * 标记密钥使用成功
   */
  async markSuccess(keyId) {
    await ProviderKey.incrementUsage(keyId);
  }

  /**
   * 标记密钥失败，进入冷却期
   */
  async markFailure(keyId, cooldownSeconds = 60) {
    await ProviderKey.setCooldown(keyId, cooldownSeconds);
    logger.warn('密钥进入冷却', { keyId, cooldownSeconds });
  }
}

module.exports = new KeyRotator();
