(function initializeRealViewAnalytics() {
  const measurementId = 'G-VRX4RKBXN6';
  const allowedEvents = new Set([
    'analysis_start',
    'analysis_complete',
    'analysis_error',
    'sign_up',
    'login',
    'generate_lead'
  ]);
  const allowedParameters = new Set(['marketplace', 'method', 'error_type']);

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function gtag() {
    window.dataLayer.push(arguments);
  };

  window.gtag('js', new Date());
  window.gtag('config', measurementId, {
    anonymize_ip: true,
    allow_google_signals: false
  });

  const loader = document.createElement('script');
  loader.async = true;
  loader.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
  document.head.appendChild(loader);

  window.realviewMarketplaceFromUrl = function realviewMarketplaceFromUrl(value) {
    const normalized = String(value || '').toLowerCase();
    if (normalized.includes('shopee.')) return 'shopee';
    if (normalized.includes('tiktok.com')) return 'tiktok';
    return 'unknown';
  };

  window.realviewTrackEvent = function realviewTrackEvent(name, parameters) {
    if (!allowedEvents.has(name)) return;
    const safeParameters = {};
    Object.entries(parameters || {}).forEach(([key, value]) => {
      if (!allowedParameters.has(key)) return;
      if (!['string', 'number', 'boolean'].includes(typeof value)) return;
      safeParameters[key] = String(value).slice(0, 60);
    });
    window.gtag('event', name, safeParameters);
  };
})();

