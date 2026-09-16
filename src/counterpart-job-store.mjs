import { createHash, randomUUID } from 'node:crypto';
import { findCounterpart, normalizePlatform, targetPlatformFor } from './counterpart-search.mjs';
import { isRedisConfigured, redisCommand } from './redis-rest.mjs';
import { platformMaintenanceStatus } from './platform-availability.mjs';

const JOB_PREFIX = 'realview:counterpart:v3:job:';
const JOB_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOCK_TTL_SECONDS = 116;
const ATTEMPT_DEADLINE_MS = 105_000;
const TERMINAL = new Set(['ready', 'unavailable', 'disabled']);

function cleanSource(source = {}) {
  return {
    platform: normalizePlatform(source.platform),
    title: String(source.title || '').trim().slice(0, 240),
    url: String(source.url || '').trim().slice(0, 2_000),
    image: String(source.image || '').trim().slice(0, 2_000),
    itemId: String(source.itemId || '').trim().slice(0, 80),
    productId: String(source.productId || '').trim().slice(0, 80),
    resultId: String(source.resultId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
    analysisCompletedAt: Number.isFinite(Date.parse(source.analysisCompletedAt || ''))
      ? new Date(source.analysisCompletedAt).toISOString()
      : ''
  };
}

export function counterpartJobId(source = {}) {
  const clean = cleanSource(source);
  const stable = clean.itemId || clean.productId || clean.url;
  const imageIdentity = createHash('sha256').update(clean.image).digest('hex').slice(0, 12);
  return createHash('sha256').update(`v3|${clean.platform}|${stable}|${imageIdentity}`).digest('hex').slice(0, 32);
}

function jobKey(jobId) {
  return `${JOB_PREFIX}${jobId}`;
}

function lockKey(jobId) {
  return `${jobKey(jobId)}:lock`;
}

async function writeJob(job, options = {}) {
  const value = { ...job, updatedAt: new Date().toISOString() };
  const ttl = job.status === 'unavailable' ? 12 * 60 * 60 : job.status === 'disabled' ? 5 * 60 : JOB_TTL_SECONDS;
  await redisCommand(['SET', jobKey(job.id), JSON.stringify(value), 'EX', String(ttl)], {
    fetchImpl: options.redisFetchImpl,
    timeoutMs: 2_000
  });
  return value;
}

export async function readCounterpartJob(jobId, options = {}) {
  if (!isRedisConfigured() || !/^[a-f0-9]{32}$/.test(String(jobId || ''))) return null;
  const raw = await redisCommand(['GET', jobKey(jobId)], { fetchImpl: options.redisFetchImpl, timeoutMs: 2_000 }).catch(() => null);
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

function analysisAvailability(job, env = process.env) {
  const targetPlatform = job?.result?.targetPlatform || targetPlatformFor(job?.source?.platform);
  const status = platformMaintenanceStatus(targetPlatform, env);
  if (status.enabled) return { enabled: true, platform: targetPlatform };
  return {
    enabled: false,
    platform: targetPlatform,
    reason: 'platform_review_maintenance',
    message: status.message
  };
}

export function publicCounterpartJob(job, options = {}) {
  if (!job) return null;
  const base = {
    jobId: job.id,
    status: job.status,
    stage: job.stage || job.status,
    updatedAt: job.updatedAt,
    retryAfterMs: TERMINAL.has(job.status) ? undefined : 2_500
  };
  if (job.status === 'ready') {
    return { ...base, ...(job.result || {}), analysisAvailability: analysisAvailability(job, options.env || process.env) };
  }
  if (job.status === 'unavailable' || job.status === 'disabled') {
    return { ...base, reason: job.result?.reason || job.reason || 'not_available' };
  }
  return base;
}

async function processJob(job, lockId, options = {}) {
  const startedAtMs = Date.now();
  const stageDurationsMs = {};
  let previousStage = 'queued';
  let previousStageStartedAtMs = startedAtMs;
  let current = { ...job, status: 'running', stage: 'queued' };
  try {
    console.log(JSON.stringify({
      level: 'info',
      event: 'counterpart_search_started',
      jobId: job.id,
      resultId: job.source?.resultId || null,
      sourcePlatform: job.source?.platform || null,
      targetPlatform: targetPlatformFor(job.source?.platform) || null
    }));
    current = await writeJob(current, options);
    const result = await (options.findCounterpartImpl || findCounterpart)(job.source, {
      ...options,
      deadlineAt: Number(options.deadlineAt) || (Date.now() + ATTEMPT_DEADLINE_MS),
      onStage: async (stage, detail) => {
        const nowMs = Date.now();
        stageDurationsMs[previousStage] = (stageDurationsMs[previousStage] || 0) + (nowMs - previousStageStartedAtMs);
        previousStage = stage;
        previousStageStartedAtMs = nowMs;
        console.log(JSON.stringify({
          level: 'info',
          event: 'counterpart_stage_started',
          jobId: job.id,
          resultId: job.source?.resultId || null,
          stage,
          elapsedMs: nowMs - startedAtMs,
          candidates: Number(detail?.candidates) || undefined
        }));
        current = await writeJob({ ...current, status: 'running', stage, stageDetail: detail }, options);
      }
    });
    current = await writeJob({
      ...current,
      status: result.status === 'ready' ? 'ready' : result.status === 'disabled' ? 'disabled' : 'unavailable',
      stage: result.status === 'ready' ? 'ready' : 'complete',
      result
    }, options);
    const completedAtMs = Date.now();
    stageDurationsMs[previousStage] = (stageDurationsMs[previousStage] || 0) + (completedAtMs - previousStageStartedAtMs);
    const analysisCompletedAtMs = Date.parse(job.source?.analysisCompletedAt || '');
    console.log(JSON.stringify({
      level: 'info',
      event: 'counterpart_search_complete',
      jobId: job.id,
      resultId: job.source?.resultId || null,
      status: result.status,
      reason: result.reason || null,
      provider: result.discovery?.provider || null,
      cacheHit: Boolean(result.cached),
      candidateCount: result.candidate ? 1 : 0,
      hasEnoughReviews: result.candidate?.hasEnoughReviews ?? null,
      totalDurationMs: completedAtMs - startedAtMs,
      resultToReadyDurationMs: Number.isFinite(analysisCompletedAtMs) ? Math.max(0, completedAtMs - analysisCompletedAtMs) : null,
      stageDurationsMs
    }));
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'counterpart_search_failed',
      jobId: job.id,
      resultId: job.source?.resultId || null,
      durationMs: Date.now() - startedAtMs,
      code: error?.code || 'search_failed',
      message: String(error?.message || '').slice(0, 180)
    }));
    current = await writeJob({
      ...current,
      status: 'unavailable',
      stage: 'failed',
      reason: error?.code || 'search_failed'
    }, options).catch(() => current);
  } finally {
    const activeLock = await redisCommand(['GET', lockKey(job.id)], { fetchImpl: options.redisFetchImpl, timeoutMs: 1_500 }).catch(() => null);
    if (activeLock === lockId) {
      await redisCommand(['DEL', lockKey(job.id)], { fetchImpl: options.redisFetchImpl, timeoutMs: 1_500 }).catch(() => null);
    }
  }
  return current;
}

async function schedule(job, options = {}) {
  if (TERMINAL.has(job.status)) return { job, background: null };
  const lockId = randomUUID();
  const locked = await redisCommand(['SET', lockKey(job.id), lockId, 'NX', 'EX', String(LOCK_TTL_SECONDS)], {
    fetchImpl: options.redisFetchImpl,
    timeoutMs: 2_000
  }).catch(() => null);
  return { job, background: locked ? processJob(job, lockId, options) : null };
}

export async function createCounterpartJob(source, options = {}) {
  if (!isRedisConfigured()) return { job: { id: counterpartJobId(source), status: 'disabled', reason: 'redis_not_configured' }, background: null };
  const clean = cleanSource(source);
  const id = counterpartJobId(clean);
  let job = await readCounterpartJob(id, options);
  if (!job) {
    const createdAt = new Date().toISOString();
    const initial = { id, status: 'queued', stage: 'queued', source: clean, createdAt, updatedAt: createdAt };
    const created = await redisCommand(['SET', jobKey(id), JSON.stringify(initial), 'NX', 'EX', String(JOB_TTL_SECONDS)], {
      fetchImpl: options.redisFetchImpl,
      timeoutMs: 2_000
    });
    job = created ? initial : await readCounterpartJob(id, options);
  }
  return schedule(job, options);
}

export async function resumeCounterpartJob(jobId, options = {}) {
  const job = await readCounterpartJob(jobId, options);
  if (!job) return { job: null, background: null };
  return schedule(job, options);
}
