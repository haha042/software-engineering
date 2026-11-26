const dayMs = 86_400_000;
const chinaOffset = 8 * 3_600_000;

export function summarize(db, now, period) {
  const localDate = new Date(now + chinaOffset);
  const today = Math.floor((now + chinaOffset) / dayMs) * dayMs - chinaOffset;
  const weekly = period === 'week';
  const step = weekly ? 7 * dayMs : dayMs;
  const count = weekly ? 4 : 7;
  const current = today - (weekly ? ((localDate.getUTCDay() + 6) % 7) * dayMs : 0);
  const start = current - (count - 1) * step;
  const end = now + 1;

  const groupProducts = column => db.prepare(`
    SELECT ${column} AS name, count(*) AS count FROM products
    WHERE status <> 'draft' GROUP BY ${column} ORDER BY ${column}
  `).all();
  const orderRows = db.prepare(`
    SELECT CAST((created_at - ?) / ? AS INTEGER) AS bucket, status, count(*) AS count
    FROM orders WHERE created_at >= ? AND created_at < ?
    GROUP BY bucket, status ORDER BY bucket, status
  `).all(start, step, start, end);
  const userRows = db.prepare(`
    SELECT CAST((created_at - ?) / ? AS INTEGER) AS bucket,
           count(*) AS registered, sum(certified = 1) AS certified
    FROM users WHERE role = 'student' AND created_at >= ? AND created_at < ?
    GROUP BY bucket
  `).all(start, step, start, end);
  const usersByBucket = new Map(userRows.map(row => [row.bucket, row]));
  const buckets = Array.from({length: count}, (_, bucket) => {
    const orders = orderRows.filter(row => row.bucket === bucket);
    const users = usersByBucket.get(bucket);
    return {
      date: new Date(start + bucket * step + chinaOffset).toISOString().slice(0, 10),
      orders: orders.reduce((sum, row) => sum + row.count, 0),
      orderStatuses: orders.map(({status, count}) => ({status, count})),
      registered: users?.registered ?? 0,
      certified: users?.certified ?? 0,
      banned: null
    };
  });

  return {
    period,
    timezone: 'Asia/Shanghai',
    products: {
      statuses: groupProducts('status'),
      categories: groupProducts('category'),
      tradeTypes: groupProducts('trade_type')
    },
    buckets
  };
}
