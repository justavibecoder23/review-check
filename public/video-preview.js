(function initializeVideoPreview() {
  const preview = document.querySelector('[data-video-preview]');
  if (!preview) return;
  preview.addEventListener('click', (event) => {
    // Keep native open-in-new-tab and no-JavaScript fallback behavior.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!preview.isConnected) return;
    const iframe = document.createElement('iframe');
    iframe.title = 'Hướng dẫn sử dụng RealView — video YouTube';
    iframe.width = '560';
    iframe.height = '315';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    iframe.allowFullscreen = true;
    iframe.addEventListener('load', () => iframe.focus(), { once: true });
    // No embed/player connection exists before an explicit user action.
    iframe.src = 'https://www.youtube-nocookie.com/embed/qtVxLsrjLLs?autoplay=1';
    preview.replaceWith(iframe);
  });
})();
