// "🌍 Visitor Map" above the footer: a button that opens a spinning globe with a red point for every city visitors came from.
// The page reports one visit per browser session to the visitor-stats Worker (visitor-stats/ in this repository), which
// locates it by IP address and returns the totals from /stats. Away from the live site (e.g. a local preview) the map shows
// sample data and nothing is recorded.
(() => {
  const root = document.getElementById("visitor-map");
  if (!root || root.dataset.initialized) return;
  root.dataset.initialized = "true";

  const toggle = root.querySelector(".visitor-map-toggle");
  const panel = root.querySelector(".visitor-map-panel");
  const summary = root.querySelector(".visitor-map-summary");
  const note = root.querySelector(".visitor-map-note");
  const globeBox = root.querySelector(".visitor-map-globe");
  const retry = root.querySelector(".visitor-map-retry");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // `ocean` matches the texture's sea colour and only shows until the texture has loaded.
  const THEMES = {
    light: { texture: root.dataset.textureLight, ocean: "#d2edfb", atmosphere: "#a8d4f2" },
    dark: { texture: root.dataset.textureDark, ocean: "#152637", atmosphere: "#3f6f99" },
  };
  const POINT_COLOR = "#ff4658";
  const TEXT = {
    show: "🌍 Visitor Map",
    hide: "Hide Map",
    loading: "Loading visitor statistics…",
    preview: "Preview with sample data: visits are only recorded on the live site.",
    statsError: "Visitor statistics are temporarily unavailable.",
    globeError: "The globe cannot be shown in this browser.",
  };
  // Shown when the page is not served from the live site, so the map can be checked locally.
  const SAMPLE = {
    total: 128,
    cities: 6,
    countries: [
      { code: "CN", count: 52 },
      { code: "GB", count: 41 },
      { code: "US", count: 23 },
      { code: "DE", count: 7 },
      { code: "SG", count: 5 },
    ],
    points: [
      { country: "GB", city: "Edinburgh", lat: 55.9, lon: -3.2, count: 34 },
      { country: "CN", city: "Shenyang", lat: 41.8, lon: 123.4, count: 30 },
      { country: "CN", city: "Beijing", lat: 39.9, lon: 116.4, count: 22 },
      { country: "US", city: "Boston", lat: 42.4, lon: -71.1, count: 23 },
      { country: "GB", city: "London", lat: 51.5, lon: -0.1, count: 7 },
      { country: "DE", city: "Munich", lat: 48.1, lon: 11.6, count: 7 },
      { country: "SG", city: "Singapore", lat: 1.3, lon: 103.8, count: 5 },
    ],
  };

  // The Worker's main address, then one to try when that cannot be reached (for instance while a visitor's DNS does not
  // know the main address yet).
  const apis = [root.dataset.api, root.dataset.apiFallback]
    .map((address) => {
      try {
        return new URL(address);
      } catch {
        return null;
      }
    })
    .filter((url) => url && url.protocol === "https:");
  const origins = (root.dataset.origins || "").split(/\s+/).filter(Boolean);
  const live = apis.length > 0 && origins.includes(window.location.origin);

  let regionNames = null;
  try {
    regionNames = new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    regionNames = null;
  }
  const countryName = (code) => {
    try {
      return (regionNames && regionNames.of(code)) || code;
    } catch {
      return code;
    }
  };
  const plural = (count, one, many) => (count === 1 ? one : many);
  const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const fetchWithTimeout = async (url, options = {}, ms = 10000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const response = await fetch(url, { ...options, credentials: "omit", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } finally {
      clearTimeout(timer);
    }
  };

  // Both addresses reach the same Worker, which ignores repeat visits, so trying the next one after a failure never counts a
  // visit twice.
  const fetchApi = async (path, options) => {
    let failure;
    for (const api of apis) {
      try {
        return await fetchWithTimeout(new URL(path, api), options);
      } catch (error) {
        failure = error;
      }
    }
    throw failure;
  };

  // Count this visit once per browser session (the Worker also ignores repeats from the same visitor within 30 minutes).
  const recordVisit = () => {
    if (!live) return;
    const key = "visitor-map:recorded";
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, "1");
    } catch {
      return;
    }
    let referrer = "";
    try {
      const from = new URL(document.referrer);
      if (/^https?:$/.test(from.protocol) && from.origin !== window.location.origin) referrer = from.hostname;
    } catch {
      referrer = "";
    }
    fetchApi("/collect", {
      method: "POST",
      // A text/plain body keeps this a simple cross-origin request, so the browser sends no preflight.
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ referrer, touch: navigator.maxTouchPoints > 0 }),
      keepalive: true,
    }).catch(() => {
      try {
        window.sessionStorage.removeItem(key);
      } catch {
        // Nothing to undo.
      }
    });
  };

  const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
  const cleanStats = (data) => {
    if (!data || !isCount(data.total) || !isCount(data.cities) || !Array.isArray(data.countries) || !Array.isArray(data.points)) {
      throw new Error("Invalid statistics");
    }
    const countries = data.countries.filter((c) => /^[A-Z]{2}$/.test(c.code) && isCount(c.count) && c.count > 0);
    const points = data.points.filter(
      (p) =>
        /^[A-Z]{2}$/.test(p.country) &&
        typeof p.city === "string" &&
        Number.isFinite(p.lat) &&
        Math.abs(p.lat) <= 90 &&
        Number.isFinite(p.lon) &&
        Math.abs(p.lon) <= 180 &&
        isCount(p.count) &&
        p.count > 0
    );
    return { total: data.total, cities: data.cities, countries, points };
  };

  let stats = null;
  const loadStats = async () => {
    if (stats) return stats;
    const data = live ? await (await fetchApi("/stats")).json() : SAMPLE;
    stats = cleanStats(data);
    return stats;
  };

  const showSummary = ({ total, countries, cities }) => {
    const strong = (value) => {
      const el = document.createElement("strong");
      el.textContent = value.toLocaleString("en");
      return el;
    };
    summary.replaceChildren(
      "🌍 ",
      strong(total),
      plural(total, " visit from ", " visits from "),
      strong(countries.length),
      plural(countries.length, " country and ", " countries and "),
      strong(cities),
      plural(cities, " city", " cities")
    );
  };

  const showNote = (messages) => {
    note.textContent = messages.filter(Boolean).join(" ");
    note.hidden = !note.textContent;
  };

  // globe.gl (three.js) is about 1.9 MB, so it is only downloaded when the map is first opened.
  let globeScript = null;
  const loadGlobeScript = () => {
    if (typeof window.Globe === "function") return Promise.resolve();
    if (!globeScript) {
      globeScript = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = root.dataset.globeScript;
        script.async = true;
        script.onload = () => (typeof window.Globe === "function" ? resolve() : reject(new Error("globe.gl did not load")));
        script.onerror = () => reject(new Error("globe.gl did not load"));
        document.head.appendChild(script);
      }).catch((error) => {
        globeScript = null;
        throw error;
      });
    }
    return globeScript;
  };

  const theme = () => (document.documentElement.getAttribute("data-theme") === "dark" ? THEMES.dark : THEMES.light);

  // Load the texture before drawing, so the globe does not flash an untextured sphere first.
  const textures = new Map();
  const loadTexture = (url) => {
    if (!textures.has(url)) {
      textures.set(
        url,
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = resolve;
          image.onerror = () => {
            textures.delete(url);
            reject(new Error("Texture did not load"));
          };
          image.src = url;
        })
      );
    }
    return textures.get(url);
  };

  let globe = null;
  let maxCount = 1;

  const pointLabel = (p) => {
    const country = countryName(p.country);
    const place = p.city && p.city.toLowerCase() !== country.toLowerCase() ? `${p.city}, ${country}` : p.city || country;
    return `<span class="visitor-map-label">${escapeHtml(place)} · ${p.count.toLocaleString("en")} ${plural(p.count, "visit", "visits")}</span>`;
  };

  const applyTheme = () => {
    if (!globe) return;
    const t = theme();
    globe.globeImageUrl(t.texture).atmosphereColor(t.atmosphere);
    // globe.gl drops the material colour once a texture has loaded, so it may be gone already.
    const material = globe.globeMaterial();
    if (material.color) material.color.set(t.ocean);
  };

  const resize = () => {
    if (!globe || panel.hidden) return;
    const size = Math.round(globeBox.clientWidth);
    if (size > 0) globe.width(size).height(size);
  };

  const updateMotion = () => {
    if (!globe) return;
    globe.controls().autoRotate = !reduceMotion.matches;
    if (panel.hidden || document.hidden) globe.pauseAnimation();
    else globe.resumeAnimation();
  };

  const destroyGlobe = () => {
    if (globe) {
      globe.pauseAnimation();
      if (typeof globe._destructor === "function") globe._destructor();
    }
    globe = null;
    globeBox.replaceChildren();
  };

  const createGlobe = (points) => {
    maxCount = Math.max(1, ...points.map((p) => p.count));
    globe = new window.Globe(globeBox, { animateIn: !reduceMotion.matches, rendererConfig: { antialias: true, alpha: true } })
      .backgroundColor("rgba(0,0,0,0)")
      .showGraticules(true)
      .showAtmosphere(true)
      .atmosphereAltitude(0.16)
      .pointsData(points)
      .pointLat("lat")
      .pointLng("lon")
      .pointColor(() => POINT_COLOR)
      .pointRadius((p) => 0.35 + 0.5 * Math.sqrt(p.count / maxCount))
      // Heights follow the logarithm of the visits, so 1,000 visits stand only four times as tall as one.
      .pointAltitude((p) => Math.min(0.14, 0.02 + 0.02 * Math.log10(p.count)))
      .pointResolution(10)
      .pointsTransitionDuration(0)
      .pointLabel(pointLabel);
    const controls = globe.controls();
    controls.autoRotateSpeed = 0.6;
    controls.enableZoom = false;
    globe.pointOfView({ lat: 30, lng: 40, altitude: 2.1 }, 0);
    globe.globeMaterial().shininess = 6;
    globeBox.querySelector("canvas").addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      destroyGlobe();
      globeBox.hidden = true;
      showNote([TEXT.globeError]);
    });
    applyTheme();
    resize();
    updateMotion();
  };

  let busy = false;
  const open = async () => {
    if (busy) return;
    busy = true;
    retry.hidden = true;
    panel.setAttribute("aria-busy", "true");
    if (!stats) summary.textContent = TEXT.loading;

    let statsFailed = false;
    let globeFailed = false;
    const statsReady = loadStats()
      .then(showSummary)
      .catch(() => {
        statsFailed = true;
        summary.textContent = "";
      });
    const globeReady = Promise.all([loadGlobeScript(), loadTexture(theme().texture)]).catch(() => {
      globeFailed = true;
    });
    await Promise.all([statsReady, globeReady]);

    if (!globeFailed && !panel.hidden) {
      try {
        if (!globe) createGlobe(stats ? stats.points : []);
        else if (stats) globe.pointsData(stats.points);
      } catch {
        destroyGlobe();
        globeFailed = true;
      }
    }
    globeBox.hidden = globeFailed;
    showNote([!live && !statsFailed ? TEXT.preview : "", statsFailed ? TEXT.statsError : "", globeFailed ? TEXT.globeError : ""]);
    retry.hidden = !statsFailed && !globeFailed;
    panel.removeAttribute("aria-busy");
    busy = false;
  };

  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    toggle.textContent = panel.hidden ? TEXT.show : TEXT.hide;
    if (!panel.hidden) {
      resize();
      open();
    }
    updateMotion();
  });
  retry.addEventListener("click", () => {
    globeBox.hidden = false;
    open();
  });

  new ResizeObserver(resize).observe(globeBox);
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  reduceMotion.addEventListener("change", updateMotion);
  document.addEventListener("visibilitychange", updateMotion);

  recordVisit();
})();
