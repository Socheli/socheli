/* DOC SOC-001 — manual.js
   shared IO · folio swapper · copy buttons · star fetch · plate stepper ·
   Firefox hairline fallback · click-to-load video. <8KB, no libraries. */
(function () {
  "use strict";
  var motionOK = matchMedia("(prefers-reduced-motion: no-preference)").matches;

  /* ── nav border on scroll ─────────────────────────────────── */
  var nav = document.getElementById("nav");
  var ticking = false;
  addEventListener("scroll", function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      nav.classList.toggle("scrolled", scrollY > 8);
      var pr = document.querySelector(".progress");
      if (pr) pr.classList.toggle("live", scrollY > 8);
      ticking = false;
    });
  }, { passive: true });

  /* ── progress hairline fallback (no scroll-timeline) ──────── */
  if (motionOK && !CSS.supports("animation-timeline: scroll(root)")) {
    var bar = document.querySelector(".progress .bar");
    var tip = document.querySelector(".progress .tip");
    var p = 0, raf = false;
    var onScroll = function () {
      p = scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight);
      if (raf) return;
      raf = true;
      requestAnimationFrame(function () {
        bar.style.transform = "scaleX(" + p + ")";
        tip.style.left = p * 100 + "%";
        raf = false;
      });
    };
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* ── shared IO: reveals + log cascade (bidirectional) ─────── */
  /* .in toggles off only when an element exits BELOW the viewport
     (scrolling back up), so reveals reverse; exits above keep state. */
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add("in"); return; }
      if (e.boundingClientRect.top > 0) e.target.classList.remove("in");
    });
  }, { threshold: 0.15, rootMargin: "0px 0px -10% 0px" });
  document.querySelectorAll(".rv, .log, .receipt, .fig3, .bullets").forEach(function (el) { io.observe(el); });

  /* ── folio swapper ─────────────────────────────────────────── */
  var folio = document.getElementById("folio");
  if (folio) {
    var current = "";
    var fio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var f = e.target.getAttribute("data-folio");
        if (!f || f === current) return;
        current = f;
        folio.style.opacity = "0";
        setTimeout(function () { folio.textContent = f; folio.style.opacity = "1"; }, 150);
      });
    }, { rootMargin: "-40% 0px -55% 0px" });
    document.querySelectorAll("[data-folio]").forEach(function (s) { fio.observe(s); });
  }

  /* ── pipeline plate stepper (bidirectional) ───────────────── */
  var plate = document.getElementById("fig2-plate");
  if (plate) {
    var live = []; /* steps of currently ≥50%-visible chapters; max wins */
    var sio = new IntersectionObserver(function (entries) {
      var exitedBelow = 0;
      entries.forEach(function (e) {
        var step = +e.target.getAttribute("data-step");
        var i = live.indexOf(step);
        if (e.isIntersecting) { if (i < 0) live.push(step); }
        else {
          if (i > -1) live.splice(i, 1);
          /* exit below the viewport = scrolling back up past this chapter */
          if (e.boundingClientRect.top > 0) exitedBelow = Math.max(exitedBelow, step);
        }
      });
      if (live.length) plate.setAttribute("data-step", String(Math.max.apply(null, live)));
      else if (exitedBelow > 1) plate.setAttribute("data-step", String(exitedBelow - 1));
      else if (exitedBelow === 1) plate.removeAttribute("data-step");
    }, { threshold: 0.5 });
    document.querySelectorAll(".chapter[data-step]").forEach(function (c) { sio.observe(c); });
  }

  /* ── copy buttons: ✦ copied + spark detach ─────────────────── */
  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    var label = btn.querySelector("span");
    var orig = label.textContent;
    btn.addEventListener("click", function () {
      navigator.clipboard && navigator.clipboard.writeText(btn.getAttribute("data-copy")).then(function () {
        label.textContent = "copied";
        var svg = btn.querySelector("svg");
        if (svg && motionOK) {
          svg.style.transition = "transform .24s cubic-bezier(.22,1,.36,1)";
          svg.style.transform = "translate(4px,-4px)";
          setTimeout(function () { svg.style.transform = ""; }, 280);
        }
        setTimeout(function () { label.textContent = orig; }, 1200);
      });
    });
  });

  /* ── GitHub star count (fail silent, width reserved) ───────── */
  fetch("https://api.github.com/repos/Socheli/socheli")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || typeof d.stargazers_count !== "number") return;
      var el = document.getElementById("gh-star");
      el.querySelector(".n").textContent = d.stargazers_count >= 1000
        ? (d.stargazers_count / 1000).toFixed(1) + "k" : String(d.stargazers_count);
      el.hidden = false;
    })
    .catch(function () { /* private repo / offline — keep hidden */ });

  /* ── click-to-load video ───────────────────────────────────── */
  document.querySelectorAll("[data-video]").forEach(function (box) {
    box.addEventListener("click", function load() {
      box.removeEventListener("click", load);
      var v = document.createElement("video");
      v.src = "/assets/media/run.mp4";
      v.controls = true; v.muted = false; v.playsInline = true; v.autoplay = true;
      v.width = 720; v.height = 1280;
      box.innerHTML = ""; box.appendChild(v); box.style.cursor = "default";
    }, { once: false });
  });

  /* ── magnetic colophon CTA (hover-capable + motion only) ───── */
  if (motionOK && matchMedia("(hover:hover)").matches) {
    var cta = document.getElementById("clone-cta");
    if (cta) {
      var mx = 0, my = 0, x = 0, y = 0, running = false;
      var tick = function () {
        x += (mx - x) * 0.3; y += (my - y) * 0.3;
        cta.style.transform = "translate(" + x + "px," + y + "px)";
        if (Math.abs(mx - x) < 0.1 && Math.abs(my - y) < 0.1) { running = false; return; }
        requestAnimationFrame(tick);
      };
      cta.addEventListener("mousemove", function (e) {
        var r = cta.getBoundingClientRect();
        mx = Math.max(-6, Math.min(6, (e.clientX - r.left - r.width / 2) * 0.12));
        my = Math.max(-6, Math.min(6, (e.clientY - r.top - r.height / 2) * 0.12));
        if (!running) { running = true; requestAnimationFrame(tick); }
      });
      cta.addEventListener("mouseleave", function () {
        mx = 0; my = 0;
        if (!running) { running = true; requestAnimationFrame(tick); }
      });
    }
  }
})();
