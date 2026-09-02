export function combineAbortSignals(...signals) {
  const usable = signals.filter((signal) => signal && typeof signal === 'object');
  if (!usable.length) return undefined;
  if (usable.length === 1 || typeof AbortSignal.any !== 'function') return usable[0];
  return AbortSignal.any(usable);
}

export function timeoutAbortSignal(timeoutMs, signal) {
  return combineAbortSignals(signal, AbortSignal.timeout(timeoutMs));
}

export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException('Request aborted', 'AbortError');
}
