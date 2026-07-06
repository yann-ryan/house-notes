/* ============================================================================
 * House Notes — data layer (Phase 1)
 * Wraps Supabase auth + houses/guides so the editor talks to a database
 * instead of a local file. Exposes a small API on window.hnDB.
 *
 * Expects, earlier in the page:
 *   &lt;script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2">&lt;/script tag
 *   <script> window.SUPABASE_URL=...; window.SUPABASE_ANON_KEY=...; &lt;/script tag
 * ==========================================================================*/
(function () {
  "use strict";

  // Allow tests to inject a fake client; otherwise create the real one.
  var client =
    window.__supabaseClientOverride ||
    (window.supabase && window.SUPABASE_URL && window.SUPABASE_ANON_KEY
      ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY)
      : null);

  function requireClient() {
    if (!client) throw new Error("Supabase not configured — set SUPABASE_URL and SUPABASE_ANON_KEY.");
    return client;
  }

  /* -------------------------------- auth -------------------------------- */
  async function sendMagicLink(email) {
    var c = requireClient();
    var { error } = await c.auth.signInWithOtp({
      email: email,
      options: { emailRedirectTo: window.location.origin + window.location.pathname }
    });
    if (error) throw error;
  }
  async function signOut() {
    await requireClient().auth.signOut();
  }
  async function currentUser() {
    var { data } = await requireClient().auth.getUser();
    return data ? data.user : null;
  }
  async function currentSession() {
    var { data } = await requireClient().auth.getSession();
    return data ? data.session : null;
  }
  function onAuthChange(cb) {
    // fires on sign-in, sign-out, token refresh, and once on load
    return requireClient().auth.onAuthStateChange(function (_evt, session) {
      cb(session ? session.user : null);
    });
  }

  /* ------------------------------- houses ------------------------------- */
  async function listHouses() {
    var { data, error } = await requireClient()
      .from("houses")
      .select("id,title,address,town,updated_at")
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return data;
  }
  async function createHouse(title) {
    var c = requireClient();
    var { data: u } = await c.auth.getUser();
    if (!u || !u.user) throw new Error("Not signed in.");
    var { data, error } = await c
      .from("houses")
      .insert({ owner_id: u.user.id, title: title || "Untitled house" })
      .select("id,title,address,town,updated_at")
      .single();
    if (error) throw error;
    return data; // guide row is auto-created by a DB trigger
  }
  async function deleteHouse(houseId) {
    var { error } = await requireClient().from("houses").delete().eq("id", houseId);
    if (error) throw error; // cascades to the guide row
  }
  // Keep the dashboard columns in step with the guide content the host edits.
  async function saveHouseMeta(houseId, meta) {
    var patch = {};
    if ("title" in meta) patch.title = meta.title || "Untitled house";
    if ("address" in meta) patch.address = meta.address || null;
    if ("town" in meta) patch.town = meta.town || null;
    if (!Object.keys(patch).length) return;
    var { error } = await requireClient().from("houses").update(patch).eq("id", houseId);
    if (error) throw error;
  }

  /* ------------------------------- guides ------------------------------- */
  async function loadGuide(houseId) {
    var { data, error } = await requireClient()
      .from("guides").select("content").eq("house_id", houseId).single();
    if (error) throw error;
    return data.content || {};
  }
  async function saveGuide(houseId, content) {
    var { error } = await requireClient()
      .from("guides").update({ content: content }).eq("house_id", houseId);
    if (error) throw error;
  }

  /* ------------------------- debounced autosave ------------------------- */
  // Returns a controller: call .schedule(content) on every edit; it coalesces
  // writes, keeps the house summary columns in sync, and reports status.
  function makeAutosaver(houseId, opts) {
    opts = opts || {};
    var delay = opts.delay || 1200;
    var onStatus = opts.onStatus || function () {};
    var timer = null, pending = null, inFlight = false, deriveMeta = opts.deriveMeta;

    async function flush() {
      if (inFlight || pending == null) return;
      var content = pending; pending = null; inFlight = true;
      onStatus("saving");
      try {
        await saveGuide(houseId, content);
        if (deriveMeta) { try { await saveHouseMeta(houseId, deriveMeta(content)); } catch (e) {} }
        onStatus("saved");
      } catch (e) {
        onStatus("error", e);
      } finally {
        inFlight = false;
        if (pending != null) flush(); // a write landed while saving
      }
    }
    return {
      schedule: function (content) {
        pending = content;
        onStatus("dirty");
        clearTimeout(timer);
        timer = setTimeout(flush, delay);
      },
      flushNow: function () { clearTimeout(timer); return flush(); }
    };
  }

  /* -------------------------- import existing ---------------------------
   * Accepts a previously downloaded guide (.html, possibly code-locked) or a
   * house-notes-progress.json, and returns the state object. Decryption of a
   * locked guide reuses the engine's hnDecrypt(); pass a getCode() callback.
   * -------------------------------------------------------------------- */
  async function stateFromFileText(text, getCode) {
    if (/^\s*[{\[]/.test(text)) return JSON.parse(text);
    var cm = text.match(/<script type="application\/json" id="house-notes-cipher">([\s\S]*?)<\/script>/);
    if (cm) {
      if (typeof hnDecrypt !== "function") throw new Error("Encryption support unavailable.");
      var code = await getCode();
      if (code == null) throw new Error("cancelled");
      var payload = cm[1].replace(/\\u003c/g, "<");
      var html = await hnDecrypt(payload, String(code).trim());
      text = html;
    }
    var m = text.match(/<script type="application\/json" id="house-notes-data">([\s\S]*?)<\/script>/);
    if (!m) throw new Error("No House Notes data found in that file.");
    return JSON.parse(m[1]);
  }
  // Create a new house from an imported file and store its guide.
  async function importAsNewHouse(text, getCode) {
    var state = await stateFromFileText(text, getCode);
    var title = (state.address ? String(state.address).split(",")[0] : state.town) || "Imported house";
    var house = await createHouse(title);
    await saveGuide(house.id, state);
    await saveHouseMeta(house.id, { title: title, address: state.address, town: state.town });
    return house;
  }

  window.hnDB = {
    hasClient: function () { return !!client; },
    sendMagicLink: sendMagicLink,
    signOut: signOut,
    currentUser: currentUser,
    currentSession: currentSession,
    onAuthChange: onAuthChange,
    listHouses: listHouses,
    createHouse: createHouse,
    deleteHouse: deleteHouse,
    saveHouseMeta: saveHouseMeta,
    loadGuide: loadGuide,
    saveGuide: saveGuide,
    makeAutosaver: makeAutosaver,
    stateFromFileText: stateFromFileText,
    importAsNewHouse: importAsNewHouse
  };
})();

/* ============================================================================
 * Phase 2 — stays (guest access). Appended to window.hnDB.
 * The guide is encrypted in the browser with the guest code before upload;
 * the server stores only ciphertext and gates access via get_stay().
 * ==========================================================================*/
(function () {
  "use strict";
  var DB = window.hnDB;
  if (!DB) return;

  function client() {
    var c = window.__supabaseClientOverride ||
      (window.supabase && window.SUPABASE_URL && window.SUPABASE_ANON_KEY
        ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY) : null);
    if (!c) throw new Error("Supabase not configured.");
    return c;
  }
  function randomSlug(n) {
    n = n || 12;
    var alphabet = "abcdefghijkmnpqrstuvwxyz23456789"; // no look-alikes
    var bytes = crypto.getRandomValues(new Uint8Array(n)), s = "";
    for (var i = 0; i < n; i++) s += alphabet[bytes[i] % alphabet.length];
    return s;
  }

  // Snapshot the current guide (full self-contained HTML state) and encrypt it.
  // `guideState` is the object from collect(); `code` is the guest's code.
  async function encryptSnapshot(guideState, code) {
    if (typeof hnEncrypt !== "function") throw new Error("Encryption unavailable (open over https).");
    var json = JSON.stringify(guideState);
    return JSON.parse(await hnEncrypt(json, code)); // store as jsonb
  }

  async function listStays(houseId) {
    var { data, error } = await client()
      .from("stays")
      .select("id,guest_name,slug,starts_at,ends_at,revoked,created_at,updated_at")
      .eq("house_id", houseId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  }
  async function createStay(houseId, opts) {
    // opts: { guestName, code, guideState, startsAt, endsAt }
    var cipher = await encryptSnapshot(opts.guideState, opts.code);
    var slug = randomSlug(12);
    var row = {
      house_id: houseId, guest_name: opts.guestName || null, slug: slug, cipher: cipher,
      starts_at: opts.startsAt || null, ends_at: opts.endsAt || null
    };
    var { data, error } = await client().from("stays").insert(row)
      .select("id,guest_name,slug,starts_at,ends_at,revoked").single();
    if (error) {
      // extremely unlikely slug collision: retry once
      if (String(error.message || "").match(/duplicate|unique/i)) {
        row.slug = randomSlug(14);
        var r2 = await client().from("stays").insert(row).select("id,guest_name,slug,starts_at,ends_at,revoked").single();
        if (r2.error) throw r2.error;
        return r2.data;
      }
      throw error;
    }
    return data;
  }
  async function republishStay(stayId, guideState, code) {
    var cipher = await encryptSnapshot(guideState, code);
    var { error } = await client().from("stays").update({ cipher: cipher }).eq("id", stayId);
    if (error) throw error;
  }
  async function setStayRevoked(stayId, revoked) {
    var { error } = await client().from("stays").update({ revoked: !!revoked }).eq("id", stayId);
    if (error) throw error;
  }
  async function deleteStay(stayId) {
    var { error } = await client().from("stays").delete().eq("id", stayId);
    if (error) throw error;
  }
  // Guest side: fetch an active stay's ciphertext by slug (via the gated RPC).
  async function getStayPublic(slug) {
    var { data, error } = await client().rpc("get_stay", { p_slug: slug });
    if (error) throw error;
    // returns an array (0 or 1 rows)
    return (data && data.length) ? data[0] : null;
  }

  // Build the shareable guest link for a slug (guest.html alongside the app).
  function guestUrl(slug) {
    var base = window.location.href.split("#")[0].replace(/[^/]*$/, ""); // dir of current page
    return base + "guest.html#" + slug;
  }

  Object.assign(DB, {
    listStays: listStays,
    createStay: createStay,
    republishStay: republishStay,
    setStayRevoked: setStayRevoked,
    deleteStay: deleteStay,
    getStayPublic: getStayPublic,
    guestUrl: guestUrl,
    randomSlug: randomSlug
  });
})();
