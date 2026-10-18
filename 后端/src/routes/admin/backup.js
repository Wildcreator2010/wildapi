const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const backupService = require('../../services/backupService');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const logger = require('../../utils/logger');

// 配置文件上传 (用于恢复)
const upload = multer({
  dest: backupService.BACKUP_DIR,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.sql' || ext === '.gz') {
      cb(null, true);
    } else {
      cb(new ValidationError('仅支持 .sql 或 .sql.gz 格式的备份文件'));
    }
  },
});

// ==================== 备份列表 ====================

/**
 * GET /api/admin/backup
 * 获取所有备份文件列表
 */
router.get('/', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const backups = backupService.listBackups();
    res.json({
      success: true,
      data: {
        list: backups,
        total: backups.length,
        backupDir: backupService.BACKUP_DIR,
      },
    });
  } catch (err) { next(err); }
});

// ==================== 创建备份 ====================

/**
 * POST /api/admin/backup
 * 手动触发创建数据库完整备份
 */
router.post('/', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    logger.info('管理员手动触发数据库备份', { adminId: req.user.id });

    const result = await backupService.createBackup();

    res.status(201).json({
      success: true,
      message: '数据库备份创建成功',
      data: {
        filename: result.filename,
        size: result.size,
        sizeFormatted: result.sizeFormatted,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ==================== 下载备份 ====================

/**
 * GET /api/admin/backup/:filename/download
 * 下载指定备份文件
 */
router.get('/:filename/download', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const filename = path.basename(req.params.filename);
    const filePath = path.join(backupService.BACKUP_DIR, filename);

    if (!require('fs').existsSync(filePath)) {
      throw new NotFoundError('备份文件不存在');
    }

    res.download(filePath, filename, (err) => {
      if (err) {
        logger.error('备份文件下载失败', { filename, error: err.message });
      }
    });
  } catch (err) { next(err); }
});

// ==================== 恢复备份 ====================

/**
 * POST /api/admin/backup/restore
 * 上传备份文件并恢复到数据库
 * 注意: 此操作会覆盖当前数据库!
 */
router.post('/restore', requireAuth, requireAdmin, upload.single('backupFile'), async (req, res, next) => {
  try {
    if (!req.file) {
      throw new ValidationError('请上传备份文件');
    }

    const filePath = req.file.path;
    logger.warn('管理员执行数据库恢复', {
      adminId: req.user.id,
      file: req.file.originalname,
      size: req.file.size,
    });

    const result = await backupService.restoreBackup(filePath);

    // 清理上传的临时文件
    try {
      require('fs').unlinkSync(filePath);
    } catch {}

    res.json({
      success: true,
      message: '数据库恢复成功',
      data: {
        safetyBackup: result.safetyBackup,
        warning: '数据库已恢复到备份文件内容，系统可能需要重启某些服务',
      },
    });
  } catch (err) {
    // 清理上传文件
    if (req.file?.path) {
      try { require('fs').unlinkSync(req.file.path); } catch {}
    }
    next(err);
  }
});

// ==================== 删除备份 ====================

/**
 * DELETE /api/admin/backup/:filename
 * 删除指定备份文件
 */
router.delete('/:filename', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    backupService.deleteBackup(req.params.filename);
    res.json({ success: true, message: '备份文件已删除' });
  } catch (err) { next(err); }
});

module.exports = router;
