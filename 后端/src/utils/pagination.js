/**
 * 分页参数安全兜底: 防止垃圾值/负值 (如 pageSize=abc、page=0)
 * 产生 NaN/负数进入 SQL 导致 500
 */
function parsePagination(query, { defaultPageSize = 20, maxPageSize = 100 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(Math.max(1, parseInt(query.pageSize, 10) || defaultPageSize), maxPageSize);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

module.exports = { parsePagination };
