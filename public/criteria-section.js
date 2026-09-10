(() => {
  const criteria = [
    {
      number: '01',
      title: 'Review có thông tin hữu ích',
      text: 'Ưu tiên review có thông tin hữu ích (nêu rõ chất lượng, nhược điểm, không khen chung chung); loại những review ngắn',
    },
    {
      number: '02',
      title: 'Ngôn ngữ và nội dung bất thường',
      text: 'Lọc review có ngôn ngữ bất thường (nội dung mâu thuẫn với sản phẩm, ít giá trị về mặt thông tin) và nội dung trùng lặp',
    },
    {
      number: '03',
      title: 'Ý nghĩa bị lặp lại',
      text: 'Review được paraphrase lại cùng một ý nghĩa (nhiều người mua khác nhau nhưng cùng khen một điểm với một nghĩa)',
    },
    {
      number: '04',
      title: 'Mức độ biểu đạt',
      text: 'Khen chê quá mức, ngôn ngữ mang tính quảng cáo',
    },
    {
      number: '05',
      title: 'Kết quả mang tính tham khảo',
      text: 'Không kết luận review là giả/thật 100% → Mang tính chất tham khảo dựa trên phân tích khách quan của mô hình thuật toán và AI',
    },
    {
      number: '06',
      title: 'Độc lập trong đánh giá',
      text: 'Cam kết không nhận tài trợ',
    },
  ];

  const criteriaCards = criteria
    .map(
      ({ number, title, text }) => `
        <article class="criteria-card criteria-reveal">
          <div class="criteria-card-top">
            <span class="criteria-number">${number}</span>
            <span class="criteria-check" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none"><path d="m7 12 3 3 7-7"/><circle cx="12" cy="12" r="9"/></svg>
            </span>
          </div>
          <h3>${title}</h3>
          <p>${text}</p>
        </article>`,
    )
    .join('');

  const sectionMarkup = `
    <section id="review-criteria" class="criteria-section" aria-labelledby="criteria-main-title">
      <div class="criteria-hero">
        <div class="criteria-hero-art criteria-reveal" aria-hidden="true">
          <div class="criteria-art-frame">
            <img src="/assets/illustrations/undraw-online-review.svg" alt="" />
          </div>
          <span class="criteria-art-tag">Cách chúng tôi đánh giá</span>
        </div>
        <div class="criteria-hero-copy criteria-reveal">
          <p class="criteria-purpose"><span aria-hidden="true">♥</span> Vì quyền lợi người tiêu dùng</p>
          <h1 id="criteria-main-title">Đừng để <span>review ảo</span><br />quyết định ví tiền của bạn</h1>
          <p class="criteria-mission">RealView với một sứ mệnh duy nhất:<br />Bóc tách lớp vỏ bọc seeding để mang đến cho bạn<br />những trải nghiệm mua hàng dựa trên sự thật 100%</p>
          <p class="criteria-disclaimer">Thông điệp “100%” thể hiện định hướng minh bạch của dự án; kết quả phân tích luôn mang tính tham khảo.</p>
          <a class="criteria-primary-cta" href="#evaluation-process">Tìm hiểu thuật toán <span aria-hidden="true">↓</span></a>
        </div>
      </div>

      <div class="criteria-metrics" aria-labelledby="metrics-title">
        <div class="criteria-metrics-inner">
          <div class="criteria-strip-title"><span></span><h2 id="metrics-title">Dải chỉ số uy tín RealView</h2><span></span></div>
          <div class="criteria-metric-grid">
            <div class="criteria-metric criteria-reveal"><strong>98.7%</strong><span>Đánh giá thật<br />được phát hiện</span></div>
            <div class="criteria-metric criteria-reveal"><strong>2.1M+</strong><span>Đánh giá đã<br />được phân tích</span></div>
            <div class="criteria-metric criteria-reveal"><strong>142K+</strong><span>Đánh giá seeding<br />đã được loại bỏ</span></div>
            <div class="criteria-metric criteria-reveal"><strong>500K+</strong><span>Người dùng tin tưởng<br />RealView</span></div>
          </div>
          <p class="criteria-metrics-note">Số liệu minh họa cho định hướng sản phẩm — không phải KPI vận hành thực tế. Mốc trình bày: 06/2026.</p>
        </div>
      </div>

      <div id="evaluation-process" class="criteria-process">
        <div class="criteria-section-heading criteria-reveal">
          <p>Quy trình minh bạch</p>
          <h2>Quy trình đánh giá <span>4 bước</span></h2>
          <span>Một quy trình minh bạch, có phương pháp và có thể kiểm chứng</span>
        </div>
        <ol class="criteria-steps">
          <li class="criteria-step criteria-reveal"><span class="criteria-step-number">01</span><span class="criteria-step-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg></span><h3>Thu thập dữ liệu</h3><p>Thu thập review từ các nền tảng TMĐT</p></li>
          <li class="criteria-step criteria-reveal"><span class="criteria-step-number">02</span><span class="criteria-step-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M4 5h16l-6 7v6l-4 2v-8L4 5Z"/></svg></span><h3>Lọc &amp; làm sạch</h3><p>Loại bỏ spam, trùng lặp không liên quan</p></li>
          <li class="criteria-step criteria-reveal"><span class="criteria-step-number">03</span><span class="criteria-step-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="12" cy="19" r="2"/><path d="m6.5 10.5 4-4M13.5 6.5l4 4M17.5 13.5l-4 4M10.5 17.5l-4-4"/></svg></span><h3>Phân tích &amp; chấm điểm</h3><p>Phân tích nội dung, ngữ cảnh, hành vi người dùng và tín hiệu bất thường</p></li>
          <li class="criteria-step criteria-reveal"><span class="criteria-step-number">04</span><span class="criteria-step-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M12 3 4 6v5c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V6l-8-3Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></svg></span><h3>Phân loại &amp; báo cáo</h3><p>Áp dụng thuật toán và AI độc quyền để chấm điểm độ tin cậy của review</p></li>
        </ol>
        <p class="criteria-process-note">“AI độc quyền” là nội dung định hướng trong bản thiết kế; phiên bản thử nghiệm hiện dùng bộ quy tắc và mô hình phân tích đang được hoàn thiện.</p>
      </div>

      <div id="criteria-library" class="criteria-library">
        <div class="criteria-section-heading criteria-reveal">
          <p>Minh bạch tiêu chí</p>
          <h2>Bộ <span>tiêu chí</span> đánh giá</h2>
          <span>Các tiêu chí cốt lõi mà RealView sử dụng để đánh giá độ tin cậy của mỗi review</span>
        </div>
        <div class="criteria-card-grid">${criteriaCards}</div>
        <div class="criteria-closing criteria-reveal">
          <p>Kết quả chỉ hỗ trợ tham khảo; hãy kiểm tra kỹ thông tin sản phẩm trước khi mua.</p>
          <a href="/#home">Dùng thử RealView ngay <span aria-hidden="true">→</span></a>
        </div>
      </div>

      <p class="criteria-asset-credit">Illustration: Katerina Limpitsouni · unDraw (human-made, sử dụng theo giấy phép unDraw)</p>
    </section>`;

  const mountCriteriaSection = () => {
    document.querySelectorAll('[data-realview-criteria]').forEach((mount) => {
      mount.innerHTML = sectionMarkup;
    });

    const revealItems = document.querySelectorAll('.criteria-reveal');
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      revealItems.forEach((item) => item.classList.add('is-visible'));
    } else {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          });
        },
        { threshold: 0.14, rootMargin: '0px 0px -6% 0px' },
      );
      revealItems.forEach((item) => observer.observe(item));
    }

    document.querySelectorAll('a[href="#review-criteria"], button[data-scroll-to-criteria]').forEach((control) => {
      control.addEventListener('click', (event) => {
        const target = document.querySelector('#review-criteria');
        if (!target) return;
        event.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        history.replaceState(null, '', '#review-criteria');
      });
    });
  };

  const setupBackToTop = () => {
    const backToTop = document.querySelector('.back-to-top');
    if (!backToTop) return;

    function updateBackToTop() {
      backToTop.classList.toggle('is-visible', window.scrollY > 400);
    }

    backToTop.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    window.addEventListener('scroll', updateBackToTop, { passive: true });
    updateBackToTop();
  };
  
  const setupSubpageNavigation = () => {
    const header = document.querySelector('.site-header');
    const toggle = document.querySelector('.nav-toggle');
    const toggleLabel = document.querySelector('.nav-toggle-label');
    const nav = document.querySelector('#main-navigation');
    if (!header || !toggle || !nav || toggle.dataset.ready === 'true') return;
    toggle.dataset.ready = 'true';
    const setMenuOpen = (open) => {
      header.classList.toggle('is-menu-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      if (toggleLabel) toggleLabel.textContent = open ? 'Đóng menu' : 'Mở menu';
    };
    toggle.addEventListener('click', () => {
      setMenuOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });
    nav.addEventListener('click', () => setMenuOpen(false));
    document.addEventListener('click', (event) => {
      if (header.classList.contains('is-menu-open') && !header.contains(event.target)) setMenuOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setMenuOpen(false);
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      mountCriteriaSection();
      setupSubpageNavigation();
    });
  } else {
    mountCriteriaSection();
    setupSubpageNavigation();
  }
})();
