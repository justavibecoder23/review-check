let controller;

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    function abort() { clearTimeout(timer); cleanup(); reject(new DOMException('Aborted', 'AbortError')); }
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function cancelShopeeMetadataRefresh() { controller?.abort(); }

export async function refreshShopeeProductMetadata(product, options = {}) {
  cancelShopeeMetadataRefresh();
  if (String(product?.platform).toLowerCase() !== 'shopee' || product.image || !product.url) return null;
  controller = new AbortController();
  const signal = controller.signal;
  const fetchImpl = options.fetchImpl || fetch;
  const pauseImpl = options.pauseImpl || pause;
  // Optional enrichment only. The analysis result is already available.
  for (let attempt = 0; attempt < 30; attempt++) {
    if (signal.aborted) return null;
    if (attempt) await pauseImpl(4000, signal);
    try {
      const response = await fetchImpl(`/api/match-counterpart?operation=product-metadata&sourceUrl=${encodeURIComponent(product.url)}`, { signal });
      if (!response.ok) return null;
      const value = await response.json();
      if (value.product?.image) {
        if (String(value.product.itemId) !== String(product.itemId)
          || String(value.product.shopId) !== String(product.shopId)) return null;
        return value.product;
      }
      if (value.status === 'unavailable') return null;
    } catch (error) {
      if (error?.name === 'AbortError') return null;
      // One transient cache-read error must not affect the displayed result.
    }
  }
  return null;
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', cancelShopeeMetadataRefresh);
