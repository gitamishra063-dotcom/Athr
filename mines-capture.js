/* Paste into DevTools on the loaded Mines page. No wagers or gameplay changes. */
(() => {
  "use strict";
  const GLOBAL = "MinesCapture";
  if (window[GLOBAL]?.version) {
    console.info("MinesCapture is already installed. Use MinesCapture.help().");
    return;
  }

  const MAX_ITEMS = 5000;
  const MAX_FRAMES = 1200;
  const MAX_EVENTS = 600;
  const MAX_NODES = 160;
  const MAX_ASSET_BYTES = 25 * 1024 * 1024;
  const PROPERTIES = [
    "transform", "translate", "rotate", "scale", "opacity", "filter",
    "background-image", "background-color", "background-position",
    "background-size", "mask-image", "-webkit-mask-image", "box-shadow",
    "animation-name", "animation-duration", "animation-delay",
    "animation-timing-function", "animation-iteration-count", "animation-direction",
    "animation-fill-mode", "transition-property", "transition-duration",
    "transition-delay", "transition-timing-function", "fill", "stroke", "color",
    "width", "height", "visibility", "display", "content", "perspective",
    "transform-origin", "offset-path", "offset-distance", "clip-path"
  ];
  let assets = new Map();
  let warnings = new Set();
  let report;
  let root;
  let running = false;
  let observer;
  let resourceObserver;
  let frameRequest;
  let stopTimer;
  let stopResolve;
  let pendingStop;
  let startedAt = 0;
  let lastFrame = -Infinity;
  let lastWall = -Infinity;
  let previousFrames = new Map();
  let nodeIds = new WeakMap();
  let animationIds = new WeakMap();
  let capturedAnimations = new Set();
  let snapshots = new Map();
  let nextNodeId = 1;
  let nextAnimationId = 1;
  let eventTarget;
  let api;

  const now = () => Math.round((performance.now() - startedAt) * 100) / 100;
  const warn = message => { if (warnings.size < 100) warnings.add(message); };
  const push = (list, item, limit = MAX_ITEMS) => {
    if (list.length < limit) list.push(item);
    else warn(`Capture limit reached (${limit} records). Record a shorter interaction.`);
  };
  const elements = () => [root, ...root.querySelectorAll("*")];
  const describe = node => node ? {
    tag: node.localName,
    id: node.id || null,
    classes: node.getAttribute?.("class") || null,
    label: node.getAttribute?.("aria-label") || null
  } : null;
  function idFor(node) {
    if (!nodeIds.has(node)) {
      const id = `node-${nextNodeId++}`;
      nodeIds.set(node, id);
      push(report.nodes, { id, ...describe(node) });
    }
    return nodeIds.get(node);
  }
  function styleOf(node, pseudo = null) {
    const style = getComputedStyle(node, pseudo);
    return Object.fromEntries(PROPERTIES.map(key => [key, style.getPropertyValue(key)]));
  }
  function addAsset(value, source, base = document.baseURI, kind = "resource") {
    if (!value || value.startsWith("#")) return;
    let url;
    try { url = new URL(value, base); } catch { return; }
    if (!["http:", "https:", "blob:", "data:"].includes(url.protocol)) return;
    if (!assets.has(url.href)) {
      if (assets.size >= MAX_ITEMS) return warn("Asset limit reached.");
      assets.set(url.href, { id: `asset-${assets.size + 1}`, url: url.href, kind, sources: [] });
    }
    const entry = assets.get(url.href);
    if (!entry.sources.includes(source) && entry.sources.length < 12) entry.sources.push(source);
  }
  function urlsIn(value, source, base) {
    for (const match of String(value).matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
      addAsset((match[1] ?? match[2] ?? match[3]).trim(), source, base, "css-url");
    }
  }
  function resource(entry) {
    // Never collect API requests, bodies, headers, cookies or storage.
    const image = /\.(?:svg|png|jpe?g|webp|gif|avif|apng|ico)(?:[?#]|$)/i;
    const animation = /(?:gem|diamond|bomb|mine|explos|sprite|atlas|spine|lottie)/i;
    const format = /\.(?:json|atlas|skel|ktx2?|basis|webm|mp4)(?:[?#]|$)/i;
    if (entry.initiatorType === "img" || image.test(entry.name) ||
        (["fetch", "xmlhttprequest", "css", "video"].includes(entry.initiatorType) &&
        animation.test(entry.name) && format.test(entry.name))) {
      addAsset(entry.name, `performance:${entry.initiatorType}`, undefined, "resource");
    }
  }
  function scanResources() {
    performance.getEntriesByType("resource").forEach(resource);
  }
  function inlineSvg(node) {
    if (snapshots.size >= 200) return warn("Inline SVG snapshot limit reached.");
    const svg = node.cloneNode(true);
    // Export visuals, not executable SVG or page links.
    svg.querySelectorAll("script, foreignObject").forEach(child => child.remove());
    for (const element of [svg, ...svg.querySelectorAll("*")]) {
      for (const attr of [...element.attributes]) {
        if (/^on/i.test(attr.name) || /^javascript:/i.test(attr.value.trim())) {
          element.removeAttribute(attr.name);
        }
      }
    }
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const markup = new XMLSerializer().serializeToString(svg);
    if (markup.length > 250000) return warn("Skipped an inline SVG larger than 250 KB.");
    if (!snapshots.has(markup)) {
      const key = `svg-${snapshots.size + 1}`;
      snapshots.set(markup, key);
      push(report.inlineSVGs, { id: key, node: idFor(node), markup });
    }
  }

  function scanDOM() {
    const nodes = elements();
    for (const node of nodes) {
      if (node.matches("img, source, video")) {
        addAsset(node.currentSrc || node.getAttribute("src"), `${node.localName}:src`);
        if (node.poster) addAsset(node.poster, "video:poster");
      }
      if (node.matches("svg image, svg use")) {
        addAsset(node.getAttribute("href") || node.getAttribute("xlink:href"), "svg:href");
      }
      if (node.localName === "svg") inlineSvg(node);
      for (const pseudo of [null, "::before", "::after"]) {
        const style = getComputedStyle(node, pseudo);
        for (const key of ["background-image", "mask-image", "-webkit-mask-image", "content"]) {
          urlsIn(style.getPropertyValue(key), `${node.localName}${pseudo || ""}:${key}`);
        }
      }
    }
    if (nodes.some(node => node.localName === "canvas")) {
      warn("Canvas/WebGL found: DOM capture cannot extract internal sprites or shader animations. " +
        "Resource URLs may include textures, atlases or animation data; use DevTools Network to inspect them.");
    }
    if (nodes.some(node => node.shadowRoot)) {
      warn("Shadow DOM found. Select the actual game board inside the shadow root as the capture root.");
    }
    if (nodes.some(node => node.localName === "iframe")) {
      warn("An iframe is inside this root. Switch DevTools to the game's frame and run the recorder there.");
    }
    report.nodeCount = nodes.length;
  }

  function scanCSS() {
    const seen = new Set();
    let total = 0;
    const scope = root.getRootNode();
    const sheets = new Set([
      ...document.styleSheets, ...(document.adoptedStyleSheets || []),
      ...(scope.adoptedStyleSheets || []),
      ...[...scope.querySelectorAll("style, link[rel=stylesheet]")].map(node => node.sheet).filter(Boolean)
    ]);
    function visit(sheet) {
      if (!sheet || seen.has(sheet)) return;
      seen.add(sheet);
      let rules;
      try { rules = sheet.cssRules; }
      catch {
        warn(`Cannot read cross-origin stylesheet: ${sheet.href || "unknown"}. Use DevTools Sources.`);
        return;
      }
      const base = sheet.href || document.baseURI;
      function walk(list) {
        for (const rule of list) {
          if (rule.styleSheet) visit(rule.styleSheet);
          if (rule.type === CSSRule.KEYFRAMES_RULE) {
            push(report.cssKeyframes, { name: rule.name, source: base, cssText: rule.cssText });
          } else if (rule.cssRules) walk(rule.cssRules);
          if (!rule.style) continue;
          urlsIn(rule.style.cssText, "stylesheet", base);
          if (/(?:animation|transition|transform|background|mask|filter)/i.test(rule.style.cssText)) {
            const text = rule.cssText;
            if (total + text.length <= 500000) {
              total += text.length;
              push(report.cssRules, { source: base, cssText: text });
            } else warn("CSS export capped at 500 KB; keyframes and live animation data are recorded separately.");
          }
        }
      }
      walk(rules);
    }
    sheets.forEach(visit);
  }

  function animations() {
    try {
      const list = typeof root.getAnimations === "function"
        ? root.getAnimations({ subtree: true }) : document.getAnimations();
      for (const animation of list) {
        const effect = animation.effect;
        let target = effect?.target;
        if (target && !(target instanceof Element)) target = target.element;
        if (!target || !(target === root || root.contains(target))) continue;
        if (!animationIds.has(animation)) animationIds.set(animation, `animation-${nextAnimationId++}`);
        const id = animationIds.get(animation);
        const signature = `${id}:${animation.startTime}`;
        if (capturedAnimations.has(signature)) continue;
        capturedAnimations.add(signature);
        push(report.animations, {
          id, at: now(), node: idFor(target), name: animation.animationName || null,
          transition: animation.transitionProperty || null,
          pseudoElement: effect.pseudoElement || null,
          playbackRate: animation.playbackRate, playState: animation.playState,
          currentTime: animation.currentTime, startTime: animation.startTime,
          timing: effect.getTiming(), computedTiming: effect.getComputedTiming(),
          keyframes: effect.getKeyframes()
        });
      }
    } catch (error) { warn(`Animation API: ${error.message}`); }
  }

  function sample() {
    const nodes = elements();
    if (nodes.length > MAX_NODES) warn(`Only the first ${MAX_NODES} elements are motion-sampled. Select a tighter board root.`);
    for (const node of nodes.slice(0, MAX_NODES)) {
      const id = idFor(node);
      const rect = node.getBoundingClientRect();
      for (const pseudo of [null, "::before", "::after"]) {
        const style = styleOf(node, pseudo);
        if (pseudo && ["none", "normal", '\"\"'].includes(style.content) && style["background-image"] === "none") continue;
        const state = {
          node: id, pseudo, x: rect.x, y: rect.y,
          width: rect.width, height: rect.height, style
        };
        const key = `${id}:${pseudo}`;
        const signature = JSON.stringify(state);
        if (previousFrames.get(key) !== signature) {
          previousFrames.set(key, signature);
          push(report.frames, { at: now(), ...state }, MAX_FRAMES);
        }
      }
    }
  }

  function onEvent(event) {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!target) return;
    if (target !== root && !root.contains(target)) {
      if (!target.matches("button, [role=button], input[type=button], input[type=submit]")) return;
    }
    push(report.events, {
      at: now(), type: event.type, node: idFor(target), trusted: event.isTrusted,
      animationName: event.animationName || null,
      propertyName: event.propertyName || null, elapsedTime: event.elapsedTime ?? null,
      button: event.button ?? null
    }, MAX_EVENTS);
    animations();
  }
  const EVENT_NAMES = ["click", "pointerdown", "animationstart", "animationiteration",
    "animationend", "animationcancel", "transitionrun", "transitionstart", "transitionend", "transitioncancel"];

  function tick(timestamp) {
    if (!running) return;
    try {
      if (timestamp - lastFrame >= 1000 / report.options.fps) {
        lastFrame = timestamp;
        animations();
        sample();
      }
      if (timestamp - lastWall >= 200) {
        lastWall = timestamp;
        scanDOM();
      }
    } catch (error) { warn(`Sampling: ${error.message}`); }
    frameRequest = requestAnimationFrame(tick);
  }

  function reset() {
    assets = new Map();
    warnings = new Set();
    previousFrames = new Map();
    nodeIds = new WeakMap();
    animationIds = new WeakMap();
    capturedAnimations = new Set();
    snapshots = new Map();
    nextNodeId = 1;
    nextAnimationId = 1;
    lastFrame = lastWall = -Infinity;
    startedAt = performance.now();
    report = {
      format: "mines-visual-capture", version: 1,
      page: `${location.origin}${location.pathname}`, capturedAt: new Date().toISOString(),
      note: "Observed visuals only; no hidden mine positions, wagers or gameplay modification.",
      root: describe(root), nodes: [], assets: [], inlineSVGs: [], cssKeyframes: [],
      cssRules: [], animations: [], frames: [], events: [], markers: [], warnings: []
    };
  }
  function data() {
    if (!report) throw new Error("Run MinesCapture.start({root: $0}) first.");
    return JSON.parse(JSON.stringify({
      ...report, durationMs: now(), assets: [...assets.values()], warnings: [...warnings]
    }, (_key, value) => typeof value === "number" && !Number.isFinite(value) ? String(value) : value));
  }

  function start(options = {}) {
    if (running) throw new Error("A capture is running. Stop it before starting another.");
    const selected = typeof options.root === "string" ? document.querySelector(options.root) : options.root;
    if (!(selected instanceof Element) || !selected.isConnected) {
      throw new Error("Select the Mines board in Elements, then call MinesCapture.start({root: $0}).");
    }
    const seconds = Number(options.seconds ?? 30);
    const fps = Number(options.fps ?? 30);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 120) throw new Error("seconds must be between 1 and 120.");
    if (!Number.isFinite(fps) || fps < 1 || fps > 60) throw new Error("fps must be between 1 and 60.");
    root = selected;
    reset();
    report.options = { seconds, fps };
    scanCSS();
    scanDOM();
    scanResources();
    running = true;
    pendingStop = new Promise(resolve => { stopResolve = resolve; });
    eventTarget = root.getRootNode();
    EVENT_NAMES.forEach(name => eventTarget.addEventListener(name, onEvent, true));
    observer = new MutationObserver(() => { if (running) animations(); });
    observer.observe(root, { subtree: true, childList: true, attributes: true });
    if (typeof PerformanceObserver === "function") {
      resourceObserver = new PerformanceObserver(list => list.getEntries().forEach(resource));
      try { resourceObserver.observe({ type: "resource", buffered: true }); }
      catch { resourceObserver.disconnect(); }
    }
    animations();
    sample();
    frameRequest = requestAnimationFrame(tick);
    stopTimer = setTimeout(stop, seconds * 1000);
    console.info(`Recording for up to ${seconds}s. Manually start a round and click tiles. Call MinesCapture.stop() when finished.`);
    return api;
  }

  function stop() {
    if (!running) return report ? data() : null;
    running = false;
    cancelAnimationFrame(frameRequest);
    clearTimeout(stopTimer);
    observer?.disconnect();
    resourceObserver?.disconnect();
    EVENT_NAMES.forEach(name => eventTarget.removeEventListener(name, onEvent, true));
    try {
      scanDOM();
      scanResources();
      animations();
    } catch (error) { warn(`Final scan: ${error.message}`); }
    report.durationMs = now();
    const result = data();
    stopResolve(result);
    console.info(`Capture stopped: ${result.assets.length} assets, ${result.animations.length} animations. ` +
      "Use MinesCapture.download() to save the report; MinesCapture.list() to inspect assets.");
    return result;
  }
  function mark(label) {
    if (!running) throw new Error("Start recording before adding markers.");
    push(report.markers, { at: now(), label: String(label).slice(0, 200) }, 100);
  }
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { filename, bytes: blob.size, type: blob.type };
  }
  function download() {
    if (running) stop();
    return saveBlob(new Blob([JSON.stringify(data(), null, 2)], { type: "application/json" }), "mines-capture.json");
  }
  function downloadCSS() {
    if (running) stop();
    const capture = data();
    const rules = [...capture.cssKeyframes, ...capture.cssRules];
    const css = "/* Captured rules; see JSON for source URLs and computed timings. */\n" +
      [...new Set(rules.map(rule => rule.cssText))].join("\n\n");
    return saveBlob(new Blob([css], { type: "text/css" }), "mines-animations.css");
  }
  function saveSVG(id) {
    const svg = data().inlineSVGs.find(item => item.id === id);
    if (!svg) throw new Error("Unknown SVG id. Inspect MinesCapture.data().inlineSVGs.");
    return saveBlob(new Blob([svg.markup], { type: "image/svg+xml" }), `${svg.id}.svg`);
  }
  async function saveAsset(id) {
    const asset = [...assets.values()].find(item => item.id === id);
    if (!asset) throw new Error("Unknown asset id. Run MinesCapture.list() first.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(asset.url, {
        credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (Number(response.headers.get("content-length")) > MAX_ASSET_BYTES) {
        throw new Error("Asset exceeds the 25 MB download limit. Use DevTools Network instead.");
      }
      const parts = [];
      let bytes = 0;
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_ASSET_BYTES) {
          await reader.cancel();
          throw new Error("Asset exceeds the 25 MB download limit. Use DevTools Network instead.");
        }
        parts.push(value);
      }
      const type = (response.headers.get("content-type") || "application/octet-stream").split(";")[0];
      if (type === "text/html") throw new Error("Server returned HTML instead of an asset (possibly an access challenge).");
      const suffix = new URL(asset.url).pathname.match(/\.(svg|png|jpe?g|webp|gif|avif|apng|json|atlas|skel|ktx2?|basis|webm|mp4)$/i)?.[1];
      const mimeSuffix = { "image/svg+xml": "svg", "image/png": "png", "image/jpeg": "jpg",
        "image/webp": "webp", "image/gif": "gif", "application/json": "json" }[type];
      return saveBlob(new Blob(parts, { type }), `${asset.id}.${suffix || mimeSuffix || "bin"}`);
    } catch (error) {
      throw new Error(`Could not save ${id}: ${error.message}. If blocked by CORS/CSP, open its URL from DevTools Network and save it there.`);
    } finally { clearTimeout(timer); }
  }

  api = Object.freeze({
    version: "1.0.0", start, stop, data, mark, download, downloadCSS, saveSVG, saveAsset,
    get recording() { return running; },
    get finished() { return pendingStop || Promise.resolve(null); },
    list() {
      const list = [...assets.values()];
      console.table(list.map(({ id, kind, url }) => ({ id, kind, url })));
      return list;
    },
    help() {
      console.info("Select the board in Elements, then:\n" +
        "MinesCapture.start({root: $0, seconds: 30, fps: 30});\n" +
        "Manually start a round and reveal tiles. No bets are automated.\n" +
        "MinesCapture.stop(); MinesCapture.download(); MinesCapture.downloadCSS();\n" +
        "MinesCapture.list(); await MinesCapture.saveAsset('asset-1');\n" +
        "MinesCapture.saveSVG('svg-1'); // inline SVG, if present\n" +
        "Only observed visuals are captured. Canvas internals and cross-origin CSS may be inaccessible.");
    }
  });
  Object.defineProperty(window, GLOBAL, { value: api, configurable: true });
  console.info("MinesCapture installed. No recording or network requests until you start/save. Run MinesCapture.help().");
})();

