// Animated intro (lightweight canvas particles + CSS). Shown once per session, skippable.
function particles(canvas) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};
  const ctx = canvas.getContext('2d'), dpr = Math.min(devicePixelRatio || 1, 1.5);
  let w, h, raf, ps = [];
  const colors = ['#2f7bff', '#8b5cf6', '#ff2bd6'];
  const size = () => { w = canvas.width = innerWidth * dpr; h = canvas.height = innerHeight * dpr; };
  size(); addEventListener('resize', size);
  const n = Math.min(55, Math.floor(innerWidth / 9));
  for (let i = 0; i < n; i++) ps.push({ x: Math.random() * w, y: Math.random() * h, r: (Math.random() * 2 + 0.8) * dpr, vx: (Math.random() - .5) * .4 * dpr, vy: (-Math.random() * .6 - .1) * dpr, c: colors[i % 3], a: Math.random() * .6 + .3 });
  (function frame() {
    ctx.clearRect(0, 0, w, h);
    for (const p of ps) {
      p.x += p.vx; p.y += p.vy; if (p.y < -10) { p.y = h + 10; p.x = Math.random() * w; }
      ctx.globalAlpha = p.a; ctx.fillStyle = p.c; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
    }
    raf = requestAnimationFrame(frame);
  })();
  return () => { cancelAnimationFrame(raf); removeEventListener('resize', size); };
}

export function runSplash() {
  return new Promise(resolve => {
    const el = document.getElementById('splash');
    if (!el) return resolve();
    let seen = false; try { seen = !!sessionStorage.getItem('sstc_splash'); sessionStorage.setItem('sstc_splash', '1'); } catch {}
    if (seen) { el.remove(); document.body.classList.remove('splashing'); return resolve(); }
    const stop = particles(el.querySelector('canvas'));
    let done = false;
    const finish = () => {
      if (done) return; done = true; stop(); el.classList.add('out');
      setTimeout(() => { el.remove(); document.body.classList.remove('splashing'); resolve(); }, 450);
    };
    el.querySelector('#skip').addEventListener('click', finish);
    setTimeout(finish, 3600);
  });
}
