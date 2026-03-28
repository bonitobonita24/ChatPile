// ==UserScript==
// @name         AI Chat Archiver
// @namespace    ai-chat-consolidator
// @version      4.0.0
// @description  Auto-save AI conversations to your AI Chat Consolidator dashboard
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

  // ━━━ CONFIG ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const API_URL = "https://your-domain.com";  // Your dashboard URL
  const AUTOSAVE_MS = 3 * 60 * 1000;               // 3 minutes

  // ━━━ STORAGE KEYS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const K_API_KEY = "archiver_api_key";
  const K_AUTOSAVE = "archiver_autosave";
  const K_LAST_HASH = "archiver_last_hash";
  const K_COLLAPSED = "archiver_collapsed";
  const K_PANEL_POS = "archiver_panel_pos";

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

  // ━━━ EXTRACTION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  function extractChatGPT() {
    const msgs = [];
    document.querySelectorAll("[data-message-author-role]").forEach((el) => {
      const role = el.getAttribute("data-message-author-role");
      const prose = el.querySelector(".markdown, .prose, [class*='markdown'], [class*='prose']") || el;
      const text = (prose.innerText || "").trim();
      if (text) msgs.push({ role: role === "user" ? "User" : "Assistant", text });
    });
    return msgs;
  }

  async function extractClaude() {
    // Scroll to load all virtualized messages
    const scroller = document.querySelector('[class*="overflow-y-auto"]') || document.querySelector("main") || document.documentElement;
    const orig = scroller.scrollTop;
    scroller.scrollTop = 0;
    await sleep(400);
    const step = Math.max(window.innerHeight * 0.8, 400);
    let pos = 0;
    while (pos < scroller.scrollHeight) { pos += step; scroller.scrollTop = pos; await sleep(200); }
    await sleep(300);
    scroller.scrollTop = orig;
    await sleep(200);

    const msgs = [];
    const userNodes = [...document.querySelectorAll('[data-testid="user-message"]')];
    if (userNodes.length > 0) {
      const wrapper = userNodes[0].closest('[class*="group"], article, [data-testid]')?.parentElement;
      if (wrapper) {
        for (const turn of [...wrapper.children]) {
          const userMsg = turn.querySelector('[data-testid="user-message"]');
          if (userMsg) {
            const text = (userMsg.innerText || "").trim();
            if (text) msgs.push({ role: "User", text });
          } else {
            const proseEl = turn.querySelector(".font-claude-message") || turn.querySelector('[class*="prose"]') || turn;
            const clone = proseEl.cloneNode(true);
            clone.querySelectorAll('button, [role="button"], svg, form, [class*="action"], [class*="toolbar"], [class*="copy"], [class*="vote"], [class*="footer"], [class*="controls"]').forEach(n => n.remove());
            const text = (clone.innerText || "").trim();
            if (text && text.length > 10) msgs.push({ role: "Assistant", text });
          }
        }
      }
    }

    // Fallback: alternating articles
    if (!msgs.length) {
      document.querySelectorAll("main article").forEach((el, i) => {
        const text = (el.innerText || "").trim();
        if (text) msgs.push({ role: i % 2 === 0 ? "User" : "Assistant", text });
      });
    }

    return msgs;
  }

  function extractGeneric() {
    const msgs = [];
    // Try common patterns across AI chat platforms
    const selectors = [
      '[data-message-author-role]',
      '[data-testid*="message"]',
      '[class*="message-row"]',
      '[class*="chat-message"]',
      '[class*="turn"]',
      'main article',
    ];

    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length >= 2) {
        els.forEach((el, i) => {
          const text = (el.innerText || "").trim();
          if (text && text.length > 5) {
            msgs.push({ role: i % 2 === 0 ? "User" : "Assistant", text });
          }
        });
        if (msgs.length) return msgs;
      }
    }

    // Last resort: dump main content
    const main = document.querySelector("main");
    if (main) {
      const text = (main.innerText || "").trim();
      if (text) msgs.push({ role: "Conversation", text });
    }
    return msgs;
  }

  async function extractMessages() {
    const platform = detectPlatform();
    if (platform === "chatgpt") return extractChatGPT();
    if (platform === "claudeai") return await extractClaude();
    return extractGeneric();
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
        timeout: 30000,
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
      const messages = await extractMessages();
      if (!messages.length) { if (!auto) toast("No messages found."); return; }

      const platform = detectPlatform();
      const id = getConversationId();
      const title = getTitle();
      const hash = simpleHash(JSON.stringify(messages));

      if (auto && hash === getLastHash(id)) return;
      if (!auto) toast("Saving...");

      await pushToApi({
        id,
        title,
        platform,
        url: location.href,
        captured: new Date().toISOString(),
        messages,
      });

      setLastHash(id, hash);
      toast(`${auto ? "Auto-saved" : "Saved"}: ${title} (${messages.length} msgs)`);
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
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      const rect = wrap.getBoundingClientRect();
      origLeft = rect.left; origTop = rect.top;
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      wrap.style.left = `${origLeft + dx}px`;
      wrap.style.top = `${origTop + dy}px`;
      wrap.style.right = "auto"; wrap.style.bottom = "auto";
    });

    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      GM_setValue(K_PANEL_POS, JSON.stringify({
        left: parseInt(wrap.style.left), top: parseInt(wrap.style.top),
      }));
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

    const autoRow = document.createElement("label");
    Object.assign(autoRow.style, { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px", userSelect: "none", fontSize: "12px" });
    const autoCb = document.createElement("input");
    autoCb.type = "checkbox";
    autoCb.checked = getAutosave();
    autoCb.onchange = () => { setAutosave(autoCb.checked); toast(`Auto-save ${autoCb.checked ? "on" : "off"}`); };
    autoRow.appendChild(autoCb);
    autoRow.appendChild(document.createTextNode("Auto-save"));
    content.appendChild(autoRow);

    const btnKey = makeButton("Set API Key");
    btnKey.onclick = () => {
      const current = getApiKey();
      const v = prompt("Paste your API Key from Settings → Tampermonkey API Key:", current || "");
      if (v && v.trim()) { setApiKey(v.trim()); toast("API key saved."); }
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

  // Autosave loop
  setInterval(async () => {
    if (!getAutosave()) return;
    if (!document.querySelector("main")) return;
    await save(true);
  }, AUTOSAVE_MS);
})();
