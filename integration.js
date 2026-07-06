/* ============================================================================
 * House Notes — app integration (Phase 1)
 * Ties the data layer (window.hnDB) to the existing editor engine, which
 * exposes these globals: collect(), applyState(state), refresh(),
 * downloadGuide(), hnDecrypt(). Replaces the file-based Save/Load with a
 * database: houses live in Supabase, the guide autosaves as you type.
 *
 * DOM contract (see index.html):
 *   #view-auth      sign-in screen   (#auth-email, #auth-send, #auth-msg)
 *   #view-dash      dashboard        (#house-list, #new-house, #import-file, #sign-out, #dash-email)
 *   #view-editor    the builder      (#back-to-dash, #save-status, #export-guide, + existing builder DOM)
 * ==========================================================================*/
(function () {
  "use strict";
  var DB = window.hnDB;
  var current = { houseId: null, autosaver: null, wired: false };

  function show(view) {
    ["auth", "dash", "editor"].forEach(function (v) {
      var el = document.getElementById("view-" + v);
      if (el) el.hidden = v !== view;
    });
    document.body.setAttribute("data-view", view);
  }
  function byId(id) { return document.getElementById(id); }

  /* ------------------------------- auth UI ------------------------------ */
  function initAuthScreen() {
    var email = byId("auth-email"), send = byId("auth-send"), msg = byId("auth-msg");
    async function submit() {
      var addr = (email.value || "").trim();
      if (!addr) { email.focus(); return; }
      send.disabled = true; msg.textContent = "Sending…";
      try {
        await DB.sendMagicLink(addr);
        msg.textContent = "Check your email for a sign-in link.";
      } catch (e) {
        msg.textContent = "Couldn't send the link: " + (e.message || e);
        send.disabled = false;
      }
    }
    send.addEventListener("click", submit);
    email.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
  }

  /* ------------------------------ dashboard ----------------------------- */
  async function renderDashboard(user) {
    var em = byId("dash-email"); if (em) em.textContent = user.email || "";
    var list = byId("house-list");
    list.innerHTML = "<li class='hint'>Loading…</li>";
    try {
      var houses = await DB.listHouses();
      if (!houses.length) { list.innerHTML = "<li class='hint'>No houses yet — create one to start.</li>"; return; }
      list.innerHTML = "";
      houses.forEach(function (h) {
        var li = document.createElement("li");
        li.className = "house-row";
        var meta = [h.town, h.address].filter(Boolean).join(" · ");
        li.innerHTML =
          "<button class='house-open'></button>" +
          "<button class='house-del' title='Delete'>✕</button>";
        var open = li.querySelector(".house-open");
        open.innerHTML = "<span class='h-title'></span><span class='h-meta'></span>";
        open.querySelector(".h-title").textContent = h.title || "Untitled house";
        open.querySelector(".h-meta").textContent = meta;
        open.addEventListener("click", function () { openEditor(h.id); });
        li.querySelector(".house-del").addEventListener("click", async function (ev) {
          ev.stopPropagation();
          if (!confirm("Delete “" + (h.title || "this house") + "” and its guide? This can't be undone.")) return;
          await DB.deleteHouse(h.id);
          renderDashboard(user);
        });
        list.appendChild(li);
      });
    } catch (e) {
      list.innerHTML = "<li class='hint'>Couldn't load houses: " + (e.message || e) + "</li>";
    }
  }

  function initDashboard(user) {
    byId("new-house").addEventListener("click", async function () {
      var title = prompt("Name this house (you can change it later):", "Our place");
      if (title == null) return;
      var h = await DB.createHouse(title.trim() || "Untitled house");
      openEditor(h.id);
    });
    byId("sign-out").addEventListener("click", async function () { await DB.signOut(); });
    var imp = byId("import-file");
    imp.addEventListener("change", async function (ev) {
      var file = ev.target.files[0]; ev.target.value = "";
      if (!file) return;
      var text = await file.text();
      try {
        var house = await DB.importAsNewHouse(text, function () {
          return prompt("This guide is code-locked. Enter its code to import:");
        });
        openEditor(house.id);
      } catch (e) {
        if (String(e.message) !== "cancelled")
          alert("Couldn't import that file: " + (e.message || e));
      }
    });
  }

  /* ------------------------------- editor ------------------------------- */
  function setStatus(state, err) {
    var el = byId("save-status"); if (!el) return;
    el.className = "save-status " + state;
    el.textContent =
      state === "saving" ? "Saving…" :
      state === "saved"  ? "Saved ✓" :
      state === "dirty"  ? "Editing…" :
      state === "error"  ? "Save failed — retrying on next edit" : "";
    if (state === "error") { el.title = err ? (err.message || String(err)) : ""; }
  }

  // Wire the existing editor's inputs to autosave — once.
  function wireEditorInputsOnce() {
    if (current.wired) return;
    current.wired = true;
    var handler = function () {
      if (!current.autosaver || typeof collect !== "function") return;
      current.autosaver.schedule(collect());
    };
    // Covers native fields and the engine's dynamically-added rows/photos.
    document.addEventListener("input", handler, true);
    document.addEventListener("change", handler, true);
    document.addEventListener("click", function (e) {
      // add/remove row buttons mutate state without an input event
      if (e.target.closest && e.target.closest("#view-editor")) setTimeout(handler, 0);
    }, true);
    // best-effort save when leaving the page
    window.addEventListener("beforeunload", function () {
      if (current.autosaver) current.autosaver.flushNow();
    });
  }

  async function openEditor(houseId) {
    show("editor");
    window.hnCurrentHouseId = houseId;
    setStatus("saving"); // loading
    try {
      var content = await DB.loadGuide(houseId);
      current.houseId = houseId;
      if (typeof applyState === "function") applyState(content || {});
      current.autosaver = DB.makeAutosaver(houseId, {
        onStatus: setStatus,
        deriveMeta: function (c) { return { title: c.address ? String(c.address).split(",")[0] : (c.town || "Untitled house"), address: c.address, town: c.town }; }
      });
      wireEditorInputsOnce();
      setStatus("saved");
    } catch (e) {
      setStatus("error", e);
      alert("Couldn't open that guide: " + (e.message || e));
      show("dash");
    }
  }

  function initEditorChrome() {
    var back = byId("back-to-dash");
    if (back) back.addEventListener("click", async function () {
      if (current.autosaver) await current.autosaver.flushNow();
      current.houseId = null; current.autosaver = null;
      var u = await DB.currentUser();
      if (u) { await renderDashboard(u); show("dash"); }
    });
    var exp = byId("export-guide");
    if (exp) exp.addEventListener("click", function () {
      if (typeof downloadGuide === "function") downloadGuide(); // reuse engine export (+ optional code lock)
    });
  }

  /* -------------------------------- boot -------------------------------- */
  function boot() {
    if (!DB || !DB.hasClient()) {
      show("auth");
      var msg = byId("auth-msg");
      if (msg) msg.textContent = "Configure SUPABASE_URL and SUPABASE_ANON_KEY in index.html to enable sign-in.";
      return;
    }
    initAuthScreen();
    initEditorChrome();
    var dashInited = false;
    DB.onAuthChange(async function (user) {
      if (user) {
        if (!dashInited) { initDashboard(user); dashInited = true; }
        // only jump to the dashboard if we're not mid-edit
        if (document.body.getAttribute("data-view") !== "editor") {
          await renderDashboard(user); show("dash");
        }
      } else {
        show("auth");
      }
    });
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

/* ============================================================================
 * Phase 2 — Guests panel (create/list/revoke/republish guest links)
 * ==========================================================================*/
(function () {
  "use strict";
  var DB = window.hnDB;
  function $(id){ return document.getElementById(id); }
  function houseId(){ return window.hnCurrentHouseId; }

  function qrSvg(text){
    try{ var q=qrcode(0,"M"); q.addData(text); q.make();
      return q.createSvgTag({cellSize:4,margin:1,scalable:true}); }catch(e){ return ""; }
  }
  function dateToStartISO(v){ return v ? new Date(v+"T00:00:00").toISOString() : null; }
  function dateToEndISO(v){ return v ? new Date(v+"T23:59:59").toISOString() : null; }
  function fmt(d){ try{ return new Date(d).toLocaleDateString(); }catch(e){ return ""; } }
  function statusOf(s){
    if(s.revoked) return {cls:"off",label:"revoked"};
    var now=Date.now();
    if(s.starts_at && new Date(s.starts_at).getTime()>now) return {cls:"",label:"starts "+fmt(s.starts_at)};
    if(s.ends_at && new Date(s.ends_at).getTime()<now) return {cls:"off",label:"expired"};
    return {cls:"active",label:"active"};
  }

  function open(){
    var p=$("stays-panel"); if(!p) return;
    p.hidden=false;
    $("stay-guest").value=""; $("stay-code").value="";
    $("stay-start").value=""; $("stay-end").value="";
    $("stay-result").hidden=true; $("stay-result").innerHTML="";
    refreshList();
  }
  function close(){ var p=$("stays-panel"); if(p) p.hidden=true; }

  async function refreshList(){
    var list=$("stays-list");
    list.innerHTML="<li class='hint'>Loading…</li>";
    try{
      var stays=await DB.listStays(houseId());
      if(!stays.length){ list.innerHTML="<li class='hint'>No guest links yet.</li>"; return; }
      list.innerHTML="";
      stays.forEach(function(s){
        var st=statusOf(s), url=DB.guestUrl(s.slug);
        var li=document.createElement("li");
        li.className="stay-row"+(s.revoked?" revoked":"");
        var when=[s.starts_at?("from "+fmt(s.starts_at)):"", s.ends_at?("until "+fmt(s.ends_at)):""].filter(Boolean).join(" · ")||"no date limit";
        li.innerHTML=
          "<div class='top'><span class='g'></span><span class='st "+st.cls+"'>"+st.label+"</span></div>"+
          "<div class='when'></div>"+
          "<div class='btnrow'></div>";
        li.querySelector(".g").textContent=s.guest_name||"Guest";
        li.querySelector(".when").textContent=when;
        var row=li.querySelector(".btnrow");
        function mk(label,cls,fn){ var b=document.createElement("button"); b.className="mini"+(cls?" "+cls:""); b.textContent=label; b.addEventListener("click",fn); row.appendChild(b); return b; }
        mk("Copy link","",function(){ navigator.clipboard.writeText(url).then(function(){},function(){}); this.textContent="Copied ✓"; var b=this; setTimeout(function(){b.textContent="Copy link";},1200); });
        mk("QR","",function(){ showResult(s, url); });
        mk(s.revoked?"Restore":"Revoke", s.revoked?"":"warn", async function(){ await DB.setStayRevoked(s.id,!s.revoked); refreshList(); });
        mk("Update guide","",async function(){
          var code=prompt("Re-enter this guest's code to update their copy of the guide:");
          if(code==null) return;
          try{ await DB.republishStay(s.id, collect(), code.trim()); this.textContent="Updated ✓"; }
          catch(e){ alert("Couldn't update: "+(e.message||e)); }
        });
        mk("Delete","warn",async function(){ if(!confirm("Delete this guest link? The link will stop working.")) return; await DB.deleteStay(s.id); refreshList(); });
        list.appendChild(li);
      });
    }catch(e){ list.innerHTML="<li class='hint'>Couldn't load links: "+(e.message||e)+"</li>"; }
  }

  function showResult(stay, url){
    var box=$("stay-result"); box.hidden=false;
    box.innerHTML=
      "<strong>Share this with "+(stay.guest_name?escapeHtml(stay.guest_name):"your guest")+":</strong>"+
      "<div class='lk'></div>"+
      "<div class='qr'>"+qrSvg(url)+"</div>"+
      "<div class='btnrow'><button class='mini' id='sr-copy'>Copy link</button></div>"+
      "<p class='hint'>Then tell them the code separately. They open the link, type the code, and see the guide.</p>";
    box.querySelector(".lk").textContent=url;
    var c=$("sr-copy"); if(c) c.addEventListener("click",function(){ navigator.clipboard.writeText(url).then(function(){},function(){}); c.textContent="Copied ✓"; });
    box.scrollIntoView({behavior:"smooth",block:"nearest"});
  }
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g,function(m){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m];}); }

  async function create(){
    var code=($("stay-code").value||"").trim();
    if(!code){ $("stay-code").focus(); return; }
    var btn=$("stay-create"); btn.disabled=true; var old=btn.textContent; btn.textContent="Creating…";
    try{
      var stay=await DB.createStay(houseId(), {
        guestName: ($("stay-guest").value||"").trim(),
        code: code,
        guideState: collect(),
        startsAt: dateToStartISO($("stay-start").value),
        endsAt: dateToEndISO($("stay-end").value)
      });
      showResult(stay, DB.guestUrl(stay.slug));
      refreshList();
    }catch(e){ alert("Couldn't create the link: "+(e.message||e)); }
    finally{ btn.disabled=false; btn.textContent=old; }
  }

  function boot(){
    var openBtn=$("open-stays"); if(openBtn) openBtn.addEventListener("click",open);
    var closeBtn=$("stays-close"); if(closeBtn) closeBtn.addEventListener("click",close);
    var panel=$("stays-panel"); if(panel) panel.addEventListener("click",function(e){ if(e.target===panel) close(); });
    var createBtn=$("stay-create"); if(createBtn) createBtn.addEventListener("click",create);
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",boot); else boot();
})();
