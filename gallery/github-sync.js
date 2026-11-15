"use strict";
(() => {
  const repo = "tsackton/taeglar-art-review";
  const api = "https://api.github.com/repos/" + repo;
  const encoder = new TextEncoder();

  function eventPath(event) {
    if (!event || !/^(catalog-[0-9]+|vault-[a-zA-Z0-9_-]+)$/.test(event.itemId) ||
        typeof event.id !== "string" || !event.id || event.id.length > 220) {
      throw Error("A review entry has an invalid image or event ID.");
    }
    return "reviews/" + event.itemId + "/" + encodeURIComponent(event.id) + ".json";
  }

  // Deterministic JSON also lets us recognize previously synced entries by their Git blob hash.
  function serialize(event) {
    return JSON.stringify(event, (_, value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
    }, 2) + "\n";
  }

  async function blobHash(content) {
    const body = encoder.encode(content);
    const header = encoder.encode("blob " + body.length + "\0");
    const bytes = new Uint8Array(header.length + body.length);
    bytes.set(header);
    bytes.set(body, header.length);
    const subtle = globalThis.crypto?.subtle || require("node:crypto").webcrypto.subtle;
    const hash = await subtle.digest("SHA-1", bytes);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function verifySha(sha) {
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) throw Error("GitHub returned an invalid Git object.");
    return sha;
  }

  async function readTree(request, root) {
    const flat = await request("/git/trees/" + root + "?recursive=1");
    if (!flat.truncated) return flat.tree.filter(entry => entry.path.startsWith("reviews/"));

    // GitHub can truncate recursive trees. Walk just the review subtree of the same snapshot.
    const entries = [];
    async function visit(sha, prefix) {
      const tree = await request("/git/trees/" + verifySha(sha));
      if (tree.truncated) throw Error("GitHub returned an incomplete review folder. Sync stopped before publishing.");
      for (const entry of tree.tree) {
        if (!prefix && entry.path !== "reviews") continue;
        const path = prefix + entry.path;
        if (entry.type === "tree") await visit(entry.sha, path + "/");
        else entries.push({...entry, path});
      }
    }
    await visit(root, "");
    return entries;
  }

  async function readEvents(entries, authenticated, head, request) {
    const rows = [];
    for (let start = 0; start < entries.length; start += 40) {
      const batch = entries.slice(start, start + 40);
      let contents;
      if (authenticated && batch.length > 1) {
        const fields = batch.map((entry, i) => "e" + i + ':object(oid:"' + verifySha(entry.sha) + '"){... on Blob{text}}');
        const query = '{repository(owner:"tsackton",name:"taeglar-art-review"){' + fields.join(" ") + '}}';
        const result = await request("/graphql", "POST", {query});
        if (result.errors?.length || !result.data?.repository) {
          throw Error("GitHub could not read these review entries. " + (result.errors?.[0]?.message || "Check repository access and sync again."));
        }
        contents = batch.map((_, i) => result.data.repository["e" + i]?.text);
      } else if (authenticated) {
        const blob = await request("/git/blobs/" + verifySha(batch[0].sha));
        contents = [new TextDecoder("utf-8", {fatal:true}).decode(Uint8Array.from(atob(blob.content), char => char.charCodeAt(0)))];
      } else {
        // Public reads use the exact immutable commit, without spending an API request per file.
        contents = [];
        for (let i = 0; i < batch.length; i += 5) {
          const five = batch.slice(i, i + 5);
          const texts = await Promise.all(five.map(async entry => {
            const path = entry.path.split("/").map(encodeURIComponent).join("/");
            const response = await fetch("https://raw.githubusercontent.com/" + repo + "/" + head + "/" + path, {credentials:"omit", redirect:"error"});
            if (!response.ok) throw Error("GitHub could not read " + entry.path + ". Sign in if the repository is private.");
            return response.text();
          }));
          contents.push(...texts);
        }
      }
      for (let i = 0; i < batch.length; i++) {
        const text = contents[i], entry = batch[i];
        if (typeof text !== "string" || await blobHash(text) !== entry.sha) throw Error("Incomplete review file on GitHub: " + entry.path);
        const event = JSON.parse(text);
        if (eventPath(event) !== entry.path) throw Error("A review entry does not match its GitHub filename: " + entry.path);
        rows.push({event, path:entry.path, sha:entry.sha, content:serialize(event)});
      }
    }
    return rows;
  }

  async function syncArtReviews({token = "", authenticatedRequest, events, receive, pullOnly = false, onProgress = () => {}}) {
    const authenticated = Boolean(token || authenticatedRequest);
    async function request(path, method = "GET", data) {
      if (authenticatedRequest) return authenticatedRequest(path, method, data);
      const headers = {Accept:"application/vnd.github+json"};
      if (token) headers.Authorization = "Bearer " + token;
      if (data) headers["Content-Type"] = "application/json";
      const url = path === "/graphql" ? "https://api.github.com/graphql" : api + path;
      let response;
      try {
        response = await fetch(url, {method, headers, cache:"no-store", redirect:"error", credentials:"omit", body:data && JSON.stringify(data)});
      } catch {
        const error = Error("Could not reach GitHub. Your saved changes can be synced again.");
        error.status = 0;
        throw error;
      }
      if (response.ok) return response.json();
      const detail = await response.json().catch(() => ({}));
      let message = detail.message || ("HTTP " + response.status);
      if (response.status === 401) message = "The GitHub token was rejected. Enter a current token and try again.";
      if (response.status === 403 && !/rate limit/i.test(message)) message += ". Check repository access and the token’s Contents permission.";
      if (response.status === 404) message += ". Check access to " + repo + " and its main branch.";
      const error = Error(message);
      error.status = response.status;
      throw error;
    }

    const known = new Map();
    for (const event of events) {
      const path = eventPath(event), content = serialize(event);
      if (known.has(path) && known.get(path).content !== content) throw Error("Two different local entries have the same ID.");
      known.set(path, {content});
    }
    await Promise.all(Array.from(known.values(), async entry => { entry.sha = await blobHash(entry.content); }));
    let pulled = 0;
    let pendingAtStart;
    let failedHead, updateError;
    for (let attempt = 0; attempt < 6; attempt++) {
      onProgress(attempt ? "Checking concurrent changes…" : "Checking GitHub…");
      const branch = await request("/branches/main");
      const head = verifySha(branch.commit.sha), tree = verifySha(branch.commit.commit.tree.sha);
      if (head === failedHead && updateError.status !== 0 && updateError.status < 500) throw updateError;
      const remote = new Map();
      for (const entry of await readTree(request, tree)) {
        if (entry.type === "tree" || !entry.path.endsWith(".json")) continue;
        if (entry.type !== "blob" || entry.mode !== "100644" || !/^reviews\/[^/]+\/[^/]+\.json$/.test(entry.path)) {
          throw Error("Unexpected file in the review log: " + entry.path);
        }
        verifySha(entry.sha);
        remote.set(entry.path, entry);
      }
      const missing = Array.from(remote.values()).filter(entry => known.get(entry.path)?.sha !== entry.sha);
      if (missing.length) {
        onProgress("Reading " + missing.length + " shared review entries…");
        const incoming = await readEvents(missing, authenticated, head, request);
        const fresh = [];
        for (const row of incoming) {
          const existing = known.get(row.path);
          if (existing && existing.content !== row.content) throw Error("The same review ID has different contents: " + row.path);
          if (!existing) fresh.push(row.event);
        }
        // Persist/validate the incoming changes before acknowledging them or publishing ours.
        if (fresh.length) await receive(fresh);
        for (const row of incoming) known.set(row.path, row);
        pulled += fresh.length;
      }

      if (pullOnly) return {pushed:0, pulled};
      const additions = [];
      for (const [path, record] of known) {
        if (!remote.has(path)) additions.push({path, mode:"100644", type:"blob", content:record.content});
      }
      pendingAtStart ??= additions.length;
      if (!additions.length) return {pushed:pendingAtStart, pulled};
      if (!authenticated) throw Error("Shared changes were pulled. Enter a GitHub token with Contents read and write access to publish your local changes.");

      onProgress("Publishing " + additions.length + " review entries…");
      const createdTree = await request("/git/trees", "POST", {base_tree:tree, tree:additions});
      const commit = await request("/git/commits", "POST", {
        message:"Sync " + additions.length + (additions.length === 1 ? " art review entry" : " art review entries"),
        tree:verifySha(createdTree.sha), parents:[head]
      });
      try {
        await request("/git/refs/heads/main", "PATCH", {sha:verifySha(commit.sha), force:false});
        return {pushed:pendingAtStart, pulled};
      } catch (error) {
        if (![0,409,422].includes(error.status) && !(error.status >= 500)) throw error;
        failedHead = head;
        updateError = error;
      }
    }
    throw Error("The shared log changed repeatedly. Your changes are saved locally. Sync again.");
  }
  if (typeof module !== "undefined" && module.exports) module.exports = syncArtReviews;
  else window.syncArtReviews = syncArtReviews;
})();
