// Native SDK metadata, not an estimate from SQL text. A failed response may
// omit billing metadata; therefore these are observed rows, not account totals.
export function measuredD1(db, metrics) {
  function observe(result) {
    metrics.d1RowsRead += result?.meta?.rows_read || 0;
    metrics.d1RowsWritten += result?.meta?.rows_written || 0;
    return result;
  }
  function wrap(statement) {
    return { native: statement,
      bind(...values) { return wrap(statement.bind(...values)); },
      async first() { return observe(await statement.all()).results?.[0] || null; },
      async all() { return observe(await statement.all()); },
      async run() { return observe(await statement.run()); }
    };
  }
  return { prepare(sql) { return wrap(db.prepare(sql)); },
    async batch(statements) { return (await db.batch(statements.map(s => s.native))).map(observe); }
  };
}
export function measuredR2(bucket, metrics, audit) {
  if (!bucket) return bucket;
  return {
    async head(key) { metrics.r2Head++; return bucket.head(key); },
    async get(key) { metrics.r2Get++; return bucket.get(key); },
    async put(key, bytes, options) {
      // Persist intent BEFORE issuing PUT; a failed audit must not be swallowed
      // as a storage timeout, or permit a new unaudited storage write.
      await audit({ event:'put_attempted', pathname:key, bytes:bytes.length });
      metrics.r2PutAttempted++;
      let result;
      try {
        result = await bucket.put(key, bytes, options);
      } catch (error) {
        await audit({ event:'put_outcome_unknown', pathname:key });
        throw error;
      }
      if (result) { metrics.r2PutConfirmed++; await audit({ event:'put_confirmed', pathname:key }); }
      else await audit({ event:'put_condition_not_met', pathname:key });
      return result;
    }
  };
}
