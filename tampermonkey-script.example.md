// ==UserScript==
// @name         AI Chat Archiver
// @namespace    ai-chat-consolidator
// @version      5.0.0
// @description  Auto-save AI conversations with images and files to your AI Chat Consolidator dashboard
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @match        https://claude.ai/*
// @match        https://gemini.google.com/*
// @match        https://copilot.microsoft.com/*
// @match        https://www.perplexity.ai/*
// @match        https://perplexity.ai/*
// @match        https://chat.deepseek.com/*
// @match        https://grok.com/*
// @match        https://x.com/i/grok*
// @match        https://chat.mistral.ai/*
// @match        https://huggingface.co/chat/*
// @match        https://poe.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // CONFIG — Change this to your AI Chat Consolidator URL
  //
  // If you self-host: use your domain (e.g. "https://aichat.example.com")
  // The API key is set via the "Set API Key" button in the panel
  // (get it from your dashboard → Settings → Tampermonkey API Key)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const API_URL = "https://your-domain.com";
  const AUTOSAVE_MS = 3 * 60 * 1000;
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file

  // ━━━ STORAGE KEYS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const K_API_KEY = "archiver_api_key";
  const K_AUTOSAVE = "archiver_autosave";
  const K_LAST_HASH = "archiver_last_hash";
  const K_COLLAPSED = "archiver_collapsed";
  const K_PANEL_POS = "archiver_panel_pos";
  const K_CAPTURE_FILES = "archiver_capture_files";

  // ━━━ HELPERS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return h;
  }

  function getLastHash(id) {
    const data = JSON.parse(GM_getValue(K_LAST_HASH, "{}"));
    return data[id] || 0;
  }

  function setLastHash(id, hash) {
    const data = JSON.parse(GM_getValue(K_LAST_HASH, "{}"));
    data[id] = hash;
    GM_setValue(K_LAST_HASH, JSON.stringify(data));
  }

  function getAutosave() { return GM_getValue(K_AUTOSAVE, true); }
  function setAutosave(v) { GM_setValue(K_AUTOSAVE, v); }
  function getCaptureFiles() { return GM_getValue(K_CAPTURE_FILES, true); }
  function setCaptureFiles(v) { GM_setValue(K_CAPTURE_FILES, v); }

  // ━━━ PLATFORM DETECTION ━━━━━━━━━━━━━━━━━━━━━━━━━
  function detectPlatform() {
    const h = location.hostname;
    if (h.includes("claude.ai")) return "claudeai";
    if (h.includes("chatgpt") || h.includes("openai")) return "chatgpt";
    if (h.includes("gemini.google")) return "gemini";
    if (h.includes("copilot.microsoft")) return "copilot";
    if (h.includes("perplexity")) return "perplexity";
    if (h.includes("deepseek")) return "deepseek";
    if (h.includes("grok") || (h.includes("x.com") && location.pathname.includes("grok"))) return "grok";
    if (h.includes("mistral")) return "mistral";
    if (h.includes("huggingface")) return "huggingchat";
    if (h.includes("poe.com")) return "poe";
    return "unknown";
  }

  function getConversationId() {
    const p = location.pathname;
    const m = p.match(/\/(?:c|chat|thread)\/([a-zA-Z0-9_-]+)/i);
    if (m) return m[1];
    return "conv_" + simpleHash(location.href);
  }

  function getTitle() {
    return document.title
      .replace(/\s*[-|]\s*(ChatGPT|Claude|Gemini|Copilot|Perplexity|DeepSeek|Grok|Mistral|HuggingChat|Poe)\s*$/i, "")
      .trim() || "Untitled";
  }

  // ━━━ FILE EXTRACTION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  function isSmallIcon(img) {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w <= 24 || h <= 24) return true;
    const cl = (img.className || "") + " " + (img.closest("[class]")?.className || "");
    return /avatar|icon|logo|emoji|profile/i.test(cl);
  }

  function fetchAsBase64(url) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "GET", url,
        responseType: "arraybuffer",
        timeout: 15000,
        onload: (res) => {
          if (res.status < 300) {
            const bytes = new Uint8Array(res.response);
            if (bytes.length > MAX_FILE_SIZE) { resolve(null); return; }
            let binary = "";
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            const contentType = res.responseHeaders?.match(/content-type:\s*([^\r\n;]+)/i)?.[1] || "application/octet-stream";
            resolve({ data: btoa(binary), mimeType: contentType, size: bytes.length });
          } else { resolve(null); }
        },
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    });
  }

  function dataUrlToBase64(dataUrl) {
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return null;
    const data = m[2];
    if (data.length * 0.75 > MAX_FILE_SIZE) return null;
    return { data, mimeType: m[1], size: Math.floor(data.length * 0.75) };
  }

  async function extractImagesFromElement(el) {
    const attachments = [];
    const images = el.querySelectorAll("img");

    for (const img of images) {
      if (isSmallIcon(img)) continue;
      const src = img.src || img.getAttribute("src") || "";
      if (!src) continue;

      let result = null;
      if (src.startsWith("data:")) {
        result = dataUrlToBase64(src);
      } else if (src.startsWith("http")) {
        result = await fetchAsBase64(src);
      }

      if (result) {
        const ext = result.mimeType.split("/")[1]?.split("+")[0] || "png";
        attachments.push({
          fileName: `image_${attachments.length + 1}.${ext}`,
          mimeType: result.mimeType,
          data: result.data,
        });
      }
    }
    return attachments;
  }

  async function extractFilesFromElement(el) {
    const attachments = [];
    // Look for file attachment links
    const links = el.querySelectorAll('a[download], a[href*="blob:"], a[href*="/file/"], [data-testid*="file"], [class*="attachment"], [class*="file-card"]');

    for (const link of links) {
      const href = link.href || link.getAttribute("href") || "";
      const name = link.download || link.textContent?.trim() || link.getAttribute("aria-label") || "file";
      if (!href || href === "#") continue;

      const result = await fetchAsBase64(href);
      if (result) {
        attachments.push({
          fileName: name.slice(0, 100),
          mimeType: result.mimeType,
          data: result.data,
        });
      }
    }
    return attachments;
  }

  // ━━━ TEXT + FILE EXTRACTION PER PLATFORM ━━━━━━━━━
  function extractChatGPT() {
    const msgs = [];
    document.querySelectorAll("[data-message-author-role]").forEach((el) => {
      const role = el.getAttribute("data-message-author-role");
      const prose = el.querySelector(".markdown, .prose, [class*='markdown'], [class*='prose']") || el;
      const text = (prose.innerText || "").trim();
      if (text) msgs.push({ role: role === "user" ? "User" : "Assistant", text, _el: el });
    });
    return msgs;
  }

  async function scrollClaudeToLoadAll() {
    const scroller =
      document.querySelector('[class*="overflow-y-auto"]') ||
      document.querySelector("main") ||
      document.documentElement;

    // Scroll to top first so all messages load from the beginning
    scroller.scrollTop = 0;
    await sleep(600);

    // Scroll down in steps, re-check scrollHeight each iteration
    // because Claude adds DOM elements as you scroll
    const step = Math.max(window.innerHeight * 0.7, 350);
    let lastHeight = 0;
    let stableCount = 0;

    while (stableCount < 3) {
      const currentHeight = scroller.scrollHeight;
      scroller.scrollTop += step;
      await sleep(400);

      if (currentHeight === lastHeight) {
        stableCount++;
      } else {
        stableCount = 0;
      }
      lastHeight = currentHeight;

      // Safety: don't scroll forever
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 10) {
        stableCount++;
      }
    }

    // Scroll to bottom to ensure last messages are rendered
    scroller.scrollTop = scroller.scrollHeight;
    await sleep(500);
  }

  async function extractClaude() {
    await scrollClaudeToLoadAll();

    const msgs = [];

    // Strategy 1: user-message testid + sibling turns
    const userNodes = [...document.querySelectorAll('[data-testid="user-message"]')];
    if (userNodes.length > 0) {
      const wrapper = userNodes[0].closest('[class*="group"], article, [data-testid]')?.parentElement;
      if (wrapper) {
        for (const turn of [...wrapper.children]) {
          const userMsg = turn.querySelector('[data-testid="user-message"]');
          if (userMsg) {
            const text = (userMsg.innerText || "").trim();
            if (text) msgs.push({ role: "User", text, _el: turn });
          } else {
            const proseEl = turn.querySelector(".font-claude-message") || turn.querySelector('[class*="prose"]') || turn;
            const clone = proseEl.cloneNode(true);
            clone.querySelectorAll('button, [role="button"], svg, form, [class*="action"], [class*="toolbar"], [class*="copy"], [class*="vote"], [class*="footer"], [class*="controls"]').forEach(n => n.remove());
            const text = (clone.innerText || "").trim();
            if (text && text.length > 10) msgs.push({ role: "Assistant", text, _el: turn });
          }
        }
      }

      // Fallback: pair user nodes with siblings if wrapper walk failed
      if (!msgs.length) {
        userNodes.forEach((node) => {
          const text = (node.innerText || "").trim();
          if (text) msgs.push({ role: "User", text, _el: node });
          let sibling = node.closest("div, article")?.nextElementSibling;
          while (sibling) {
            const aiText = (sibling.innerText || "").trim();
            if (aiText && aiText !== text && aiText.length > 10) {
              msgs.push({ role: "Assistant", text: aiText, _el: sibling });
              break;
            }
            sibling = sibling.nextElementSibling;
          }
        });
      }
    }

    // Strategy 2: alternating articles
    if (!msgs.length) {
      document.querySelectorAll("main article").forEach((el, i) => {
        const text = (el.innerText || "").trim();
        if (text) msgs.push({ role: i % 2 === 0 ? "User" : "Assistant", text, _el: el });
      });
    }

    // Strategy 3: broad attribute search
    if (!msgs.length) {
      const seen = new Set();
      const nodes = [
        ...document.querySelectorAll('[data-testid*="human"], [data-testid*="user"]'),
        ...document.querySelectorAll('[data-testid*="assistant"], [data-testid*="claude"]'),
        ...document.querySelectorAll('[class*="human-turn"], [class*="assistant-turn"]'),
      ].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));

      for (const node of nodes) {
        const text = (node.innerText || "").trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        const lower = `${node.getAttribute("data-testid") || ""} ${node.className || ""}`.toLowerCase();
        const role = (lower.includes("user") || lower.includes("human")) ? "User" : "Assistant";
        msgs.push({ role, text, _el: node });
      }
    }

    return msgs;
  }

  function extractGeneric() {
    const msgs = [];
    const selectors = [
      '[data-message-author-role]', '[data-testid*="message"]',
      '[class*="message-row"]', '[class*="chat-message"]',
      '[class*="turn"]', 'main article',
    ];

    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length >= 2) {
        els.forEach((el, i) => {
          const text = (el.innerText || "").trim();
          if (text && text.length > 5) {
            msgs.push({ role: i % 2 === 0 ? "User" : "Assistant", text, _el: el });
          }
        });
        if (msgs.length) return msgs;
      }
    }

    const main = document.querySelector("main");
    if (main) {
      const text = (main.innerText || "").trim();
      if (text) msgs.push({ role: "Conversation", text, _el: main });
    }
    return msgs;
  }

  async function extractAll() {
    const platform = detectPlatform();
    let rawMsgs;
    if (platform === "chatgpt") rawMsgs = extractChatGPT();
    else if (platform === "claudeai") rawMsgs = await extractClaude();
    else rawMsgs = extractGeneric();

    const messages = [];
    const attachments = [];
    const captureFiles = getCaptureFiles();

    for (let i = 0; i < rawMsgs.length; i++) {
      const msg = rawMsgs[i];
      messages.push({ role: msg.role, text: msg.text });

      if (captureFiles && msg._el) {
        const imgs = await extractImagesFromElement(msg._el);
        const files = await extractFilesFromElement(msg._el);
        for (const att of [...imgs, ...files]) {
          attachments.push({ ...att, messageIndex: i });
        }
      }
    }

    return { messages, attachments };
  }

  // ━━━ API ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  function getApiKey() { return GM_getValue(K_API_KEY, ""); }
  function setApiKey(v) { GM_setValue(K_API_KEY, v); }

  function pushToApi(payload) {
    const apiKey = getApiKey();
    if (!apiKey) return Promise.reject(new Error("No API key set. Click Set API Key."));
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: `${API_URL}/api/conversations`,
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
        data: JSON.stringify(payload),
        timeout: 60000,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try { resolve(JSON.parse(res.responseText)); } catch { resolve({}); }
          } else {
            let msg = `HTTP ${res.status}`;
            try { msg = JSON.parse(res.responseText).error || msg; } catch {}
            reject(new Error(msg));
          }
        },
        onerror: () => reject(new Error("Network error")),
        ontimeout: () => reject(new Error("Request timeout")),
      });
    });
  }

  // ━━━ SAVE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  let saving = false;

  async function save(auto = false) {
    if (saving) return;
    saving = true;

    try {
      const { messages, attachments } = await extractAll();
      if (!messages.length) { if (!auto) toast("No messages found."); return; }

      const platform = detectPlatform();
      const id = getConversationId();
      const title = getTitle();
      const hash = simpleHash(JSON.stringify(messages));

      if (auto && hash === getLastHash(id)) return;
      if (!auto) toast(attachments.length ? `Saving... (${attachments.length} files)` : "Saving...");

      const payload = {
        id, title, platform,
        url: location.href,
        captured: new Date().toISOString(),
        messages,
      };

      if (attachments.length > 0) payload.attachments = attachments;

      const result = await pushToApi(payload);

      setLastHash(id, hash);
      const parts = [`${messages.length} msgs`];
      if (result.savedAttachments > 0) parts.push(`${result.savedAttachments} files`);
      toast(`${auto ? "Auto-saved" : "Saved"}: ${title}\n(${parts.join(", ")})`);
    } catch (e) {
      console.error("Save failed:", e);
      toast(`Save failed:\n${e.message}`, 5000);
    } finally {
      saving = false;
    }
  }

  // ━━━ UI ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  function toast(msg, duration = 3000) {
    let el = document.getElementById("ai-archiver-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "ai-archiver-toast";
      Object.assign(el.style, {
        position: "fixed", bottom: "20px", right: "20px", zIndex: "99999",
        background: "#1a2130", color: "#e5ecff", border: "1px solid #7ba2ff",
        borderRadius: "8px", padding: "10px 16px", fontSize: "13px",
        fontFamily: "system-ui", maxWidth: "320px", boxShadow: "0 4px 20px rgba(0,0,0,.4)",
        whiteSpace: "pre-wrap", lineHeight: "1.4",
      });
      document.body.appendChild(el);
    }
    el.textContent = msg; el.style.display = "block";
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.display = "none"; }, duration);
  }

  function makeButton(label) {
    const btn = document.createElement("button");
    btn.textContent = label;
    Object.assign(btn.style, {
      width: "100%", padding: "8px", borderRadius: "10px",
      border: "1px solid rgba(0,0,0,.15)", background: "#fff",
      cursor: "pointer", marginBottom: "8px", color: "#111", fontSize: "12px",
    });
    btn.onmouseenter = () => { btn.style.background = "#f4f4f4"; };
    btn.onmouseleave = () => { btn.style.background = "#fff"; };
    return btn;
  }

  function enableDrag(wrap, handle) {
    let dragging = false, startX, startY, origLeft, origTop;
    handle.addEventListener("mousedown", (e) => {
      dragging = true; startX = e.clientX; startY = e.clientY;
      const rect = wrap.getBoundingClientRect();
      origLeft = rect.left; origTop = rect.top; e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      wrap.style.left = `${origLeft + e.clientX - startX}px`;
      wrap.style.top = `${origTop + e.clientY - startY}px`;
      wrap.style.right = "auto"; wrap.style.bottom = "auto";
    });
    document.addEventListener("mouseup", () => {
      if (!dragging) return; dragging = false;
      GM_setValue(K_PANEL_POS, JSON.stringify({ left: parseInt(wrap.style.left), top: parseInt(wrap.style.top) }));
    });
  }

  function mountUI() {
    if (document.getElementById("ai-archiver-panel")) return;
    if (!document.body) return;

    const platform = detectPlatform();
    const label = platform.charAt(0).toUpperCase() + platform.slice(1) + " Archiver";
    const isCollapsed = GM_getValue(K_COLLAPSED, false);
    const savedPos = GM_getValue(K_PANEL_POS, null);
    const pos = savedPos ? JSON.parse(savedPos) : null;

    const wrap = document.createElement("div");
    wrap.id = "ai-archiver-panel";
    Object.assign(wrap.style, {
      position: "fixed",
      ...(pos ? { left: `${pos.left}px`, top: `${pos.top}px`, right: "auto", bottom: "auto" } : { left: "16px", bottom: "16px" }),
      zIndex: "999999", background: "rgba(255,255,255,.95)", border: "1px solid rgba(0,0,0,.12)",
      borderRadius: "12px", padding: "10px", font: "12px/1.2 system-ui",
      boxShadow: "0 10px 24px rgba(0,0,0,.12)", color: "#111", width: "220px",
      backdropFilter: "blur(8px)",
    });

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex", justifyContent: "space-between", alignItems: "center",
      marginBottom: "8px", cursor: "move",
    });

    const titleEl = document.createElement("div");
    titleEl.textContent = label;
    titleEl.style.fontWeight = "700";

    const toggleBtn = document.createElement("button");
    toggleBtn.textContent = isCollapsed ? "+" : "–";
    Object.assign(toggleBtn.style, {
      width: "24px", height: "24px", borderRadius: "6px", border: "1px solid rgba(0,0,0,.15)",
      background: "#fff", cursor: "pointer", color: "#111",
    });

    header.appendChild(titleEl);
    header.appendChild(toggleBtn);
    wrap.appendChild(header);

    const content = document.createElement("div");
    wrap.appendChild(content);

    const btnSave = makeButton("Save");
    btnSave.onclick = () => save(false);
    content.appendChild(btnSave);

    // Auto-save toggle
    const autoRow = document.createElement("label");
    Object.assign(autoRow.style, { display: "flex", gap: "6px", alignItems: "center", marginBottom: "4px", userSelect: "none", fontSize: "12px" });
    const autoCb = document.createElement("input"); autoCb.type = "checkbox"; autoCb.checked = getAutosave();
    autoCb.onchange = () => { setAutosave(autoCb.checked); toast(`Auto-save ${autoCb.checked ? "on" : "off"}`); };
    autoRow.appendChild(autoCb); autoRow.appendChild(document.createTextNode("Auto-save"));
    content.appendChild(autoRow);

    // Capture files toggle
    const fileRow = document.createElement("label");
    Object.assign(fileRow.style, { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px", userSelect: "none", fontSize: "12px" });
    const fileCb = document.createElement("input"); fileCb.type = "checkbox"; fileCb.checked = getCaptureFiles();
    fileCb.onchange = () => { setCaptureFiles(fileCb.checked); toast(`File capture ${fileCb.checked ? "on" : "off"}`); };
    fileRow.appendChild(fileCb); fileRow.appendChild(document.createTextNode("Capture images & files"));
    content.appendChild(fileRow);

    // API Key button
    const btnKey = makeButton("Set API Key");
    btnKey.onclick = () => {
      const current = getApiKey();
      const v = prompt("Paste your API Key from Settings → Tampermonkey API Key:", current || "");
      if (v && v.trim()) { setApiKey(v.trim()); toast("API key saved."); keyStatus.textContent = `Key: ...${v.trim().slice(-8)}`; }
    };
    content.appendChild(btnKey);

    const keyStatus = document.createElement("div");
    keyStatus.style.cssText = "font-size:11px;opacity:.6;margin-top:2px;margin-bottom:4px;";
    keyStatus.textContent = getApiKey() ? `Key: ...${getApiKey().slice(-8)}` : "No API key set";
    content.appendChild(keyStatus);

    const info = document.createElement("div");
    info.style.cssText = "font-size:11px;opacity:.6;margin-top:4px;";
    info.textContent = `→ ${API_URL.replace(/^https?:\/\//, "")}`;
    content.appendChild(info);

    function applyCollapse(collapsed) {
      content.style.display = collapsed ? "none" : "block";
      wrap.style.width = collapsed ? "140px" : "220px";
      toggleBtn.textContent = collapsed ? "+" : "–";
    }

    toggleBtn.onclick = () => {
      const c = !GM_getValue(K_COLLAPSED, false);
      GM_setValue(K_COLLAPSED, c);
      applyCollapse(c);
    };

    applyCollapse(isCollapsed);
    document.body.appendChild(wrap);
    enableDrag(wrap, header);
  }

  // ━━━ INIT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (!detectPlatform() || detectPlatform() === "unknown") return;

  setTimeout(() => {
    mountUI();
    toast("AI Chat Archiver active");
  }, 2000);

  setInterval(async () => {
    if (!getAutosave()) return;
    if (!document.querySelector("main")) return;
    await save(true);
  }, AUTOSAVE_MS);
})();
