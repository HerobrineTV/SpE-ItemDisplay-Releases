"use strict";

// Areas of the page (Start, Events, Builder, Rangliste, Modded, Admin): one is shown at a time, chosen by the URL hash.
// Old links to single sections (#voting, #kalender, #vergangen, ...) open the area that holds the section and scroll
// there. app.js keeps working unchanged: its scrollIntoView calls open the right area first.
(() => {
  const views = [...document.querySelectorAll("[data-view]")];
  const names = views.map((view) => view.dataset.view);
  const links = [...document.querySelectorAll("[data-view-link]")];
  const DEFAULT_VIEW = "start";

  function viewOf(element) {
    const view = element && element.closest ? element.closest("[data-view]") : null;
    return view ? view.dataset.view : null;
  }

  function show(name, { scroll = true } = {}) {
    if (!names.includes(name)) name = DEFAULT_VIEW;
    // The admin area only for admins (app.js shows its nav link)
    if (name === "control" && document.getElementById("nav-admin")?.hidden) name = DEFAULT_VIEW;
    let changed = false;
    for (const view of views) {
      const active = view.dataset.view === name;
      if (view.hidden === active) changed = true;
      view.hidden = !active;
    }
    for (const link of links) {
      if (link.dataset.viewLink === name) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    document.body.dataset.view = name;
    if (changed && scroll) window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    return name;
  }

  // Reading the hash: an area, a section inside an area, or nothing (tokens of the Discord login are left to app.js)
  function route() {
    const hash = decodeURIComponent(location.hash.slice(1));
    if (hash.startsWith("token=") || hash === "login-error") {
      show(DEFAULT_VIEW, { scroll: false });
      return;
    }
    if (!hash || names.includes(hash)) {
      show(hash || DEFAULT_VIEW);
      return;
    }
    const target = document.getElementById(hash);
    const area = viewOf(target);
    if (area) {
      show(area, { scroll: false });
      requestAnimationFrame(() => nativeScroll.call(target, { behavior: "smooth", block: "start" }));
    } else {
      show(DEFAULT_VIEW);
    }
  }

  // Sections app.js scrolls to (after voting links, results, ...) are in hidden areas: open the area first
  const nativeScroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (...args) {
    const area = viewOf(this);
    if (area && document.body.dataset.view !== area) {
      show(area, { scroll: false });
      history.replaceState(null, "", location.pathname + location.search + "#" + area);
    }
    return nativeScroll.apply(this, args);
  };

  for (const link of links) {
    link.addEventListener("click", (event) => {
      const name = link.dataset.viewLink;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      if (location.hash !== "#" + name) history.pushState(null, "", location.pathname + location.search + "#" + name);
      show(name);
    });
  }

  document.querySelectorAll("[data-copy-ip]").forEach((button) => {
    button.addEventListener("click", () => document.getElementById("server")?.click());
  });

  // The header gets a shadow as soon as the page is scrolled
  const header = document.querySelector(".top");
  const onScroll = () => header?.classList.toggle("scrolled", window.scrollY > 4);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // app.js shows #nav-admin for admins: the tab bar on phones gets the same admin tab
  const adminLink = document.getElementById("nav-admin");
  const adminMobile = document.getElementById("nav-admin-mobile");
  if (adminLink && adminMobile) {
    const sync = () => {
      adminMobile.hidden = adminLink.hidden;
      document.body.classList.toggle("is-admin", !adminLink.hidden);
    };
    new MutationObserver(sync).observe(adminLink, { attributes: true, attributeFilter: ["hidden"] });
    sync();
  }

  window.addEventListener("popstate", route);
  window.addEventListener("hashchange", route);
  route();
})();
