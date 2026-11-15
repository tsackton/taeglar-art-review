"use strict";
async function startGallery() {
  const byId = id => document.getElementById(id);
  async function readManifest(name) {
    const response = await fetch("/data/" + name);
    if (!response.ok) throw Error("Could not read " + name + " in the image source folder.");
    try {
      return await response.json();
    } catch {
      throw Error(name + " does not contain valid JSON.");
    }
  }
  const [inventory,outputs] = await Promise.all([readManifest("inventory.json"),readManifest("outputs.json")]);
  const {items} = inventory || {};
  if (!Array.isArray(items)) {
    throw Error("inventory.json must include an items list.");
  }
  if (!outputs || Array.isArray(outputs) || typeof outputs !== "object") {
    throw Error("outputs.json must contain review sets keyed by image ID.");
  }
  const kinds = {portrait: "Portrait", object: "Object", scene: "Scene or other illustration"};
  const treatments = {
    portrait: [["plain-faithful","Plain · faithful"],["plain-corrected","Plain · corrected"],["setting-faithful","Setting · faithful"],["setting-corrected","Setting · corrected"]],
    object: [["light-faithful","Light · faithful"],["light-corrected","Light · corrected"],["dark-faithful","Dark · faithful"],["dark-corrected","Dark · corrected"]],
    scene: [["faithful","Faithful"],["light-correction","Light corrections"],["full-correction","Full corrections"]]
  };
  const statuses = {ready:"Reviewed", pending:"Awaiting review", missing:"Awaiting images"};
  const reviewerKey = "art-review:taelgar-vault-restyle:reviewer";
  const log = new ReviewLog(items,outputs);
  const pageSize = 20;
  const index = new Map(items.map(item => [item.id, item]));
  let active = decodeURIComponent(location.hash.slice(1));
  let page = 0;
  let matches = [];
  const foldersById = new Map();
  const folderCounts = new Map();
  let selectedFolder = "";
  let folderPaths = [];
  const childrenByFolder = new Map();
  const unlinked = "@unlinked";
  const folderParent = path => path.includes("/") ? path.slice(0,path.lastIndexOf("/")) : "";
  const folderLabel = path => path === unlinked ? "Unlinked images" : path || "All folders";
  const rank = {ready:0, pending:1, missing:2};
  items.sort((a,b) => rank[setStatus(a)] - rank[setStatus(b)] || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const noteFolders = path => {
    const parts = path.split("/").slice(0,-1);
    return parts.length ? parts.map((_,i) => parts.slice(0,i+1).join("/")) : ["(vault root)"];
  };
  function node(tag, className, value) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (value != null) e.textContent = value;
    return e;
  }
  function action(label, fn, cls = "") {
    const b = node("button",cls,label);
    b.addEventListener("click",fn);
    return b;
  }
  function notice(message) {
    byId("notice").textContent = message;
    byId("notice").hidden = !message;
  }
  function url(path) {
    const parts = path.split("/");
    if (!["originals","thumbnails","variants"].includes(parts[0]) ||
        parts.some(part => !part || part === "." || part === ".." || part.includes("\\"))) {
      throw Error("Invalid image path in the image source: " + path);
    }
    return "/data/" + parts.map(encodeURIComponent).join("/");
  }
  function makeImage(path, alt, lazy = false) {
    const img = node("img");
    img.alt = alt;
    if (lazy) img.loading = "lazy";
    img.decoding = lazy ? "async" : "sync";
    img.src = url(path);
    return img;
  }
  function setStatus(item) {
    const result = outputs[item.id];
    return result?.reviewed ? "ready" : result ? "pending" : "missing";
  }
  function reviewedVariant(item, key) {
    return outputs[item.id]?.reviewed && outputs[item.id].variants.find(v => v.key === key);
  }
  function decision(item) {
    const state = log.state(item.id);
    return state.choice ? state : null;
  }
  function labelFor(item, key) {
    return key === "original" ? "Keep original" : treatments[item.kind]?.find(([k]) => k === key)?.[1] || key;
  }
  function describeChoice(item, state) {
    if (state.conflicts.length) return "Conflicting decisions";
    if (!state.choice) return "Open";
    return labelFor(item,state.choice) + (state.mode === "edits" ? " · Use with edits" : "");
  }
  function writeAction(item, action) {
    let author = byId("reviewerName").value.trim();
    if (!author) {
      author = (window.prompt("What name should appear beside your reviews?") || "").trim().slice(0,80);
      if (!author) return false;
      byId("reviewerName").value = author;
    }
    try {
      localStorage.setItem(reviewerKey,author);
      if (action.type === "choice") {
        log.choose(item.id,action.choice,{author,mode:action.mode || "use",editNote:action.editNote || "",expectedProposalId:action.expectedProposalId,
          ...(action.expectedVariantSha256 !== undefined && {expectedVariantSha256:action.expectedVariantSha256})});
      } else if (action.type === "review") {
        log.review(item.id,action.status,action.text,author,action.expected);
      } else if (action.type === "comment") {
        log.comment(item.id,action.text,author,{requestId:action.requestId,proposalId:action.proposalId});
      }
      notice("Saved in this browser. Sync to share your changes.");
      filter();
      return true;
    } catch (error) {
      notice(error.message);
      return false;
    }
  }
  function save(item,key) {
    return writeAction(item,{type:"choice",choice:key,expectedProposalId:log.state(item.id).proposalId});
  }
  function chooseFolder(path) {
    selectedFolder = path;
    byId("folderSearch").value = "";
    byId("folderName").textContent = folderLabel(path).split("/").join(" / ");
    page = 0;
    renderFolders();
    filter();
  }

  function renderFolders() {
    const search = byId("folderSearch").value.trim().toLowerCase();
    const list = byId("folderList");
    const up = byId("folderUp");
    list.replaceChildren();
    list.scrollTop = 0;
    up.hidden = !selectedFolder || Boolean(search);
    const parent = folderParent(selectedFolder);
    up.textContent = "← " + folderLabel(parent).split("/").pop();
    up.setAttribute("aria-label","Back to " + folderLabel(parent));
    let paths;
    if (search) {
      paths = ["",unlinked,...folderPaths].filter(path => folderLabel(path).toLowerCase().includes(search));
    } else {
      paths = childrenByFolder.get(selectedFolder) || [];
      if (!selectedFolder) paths = ["",unlinked,...paths];
      else if (parent) paths = ["",...paths];
    }
    for (const path of paths) {
      const row = action("",() => {
        chooseFolder(path);
        if (path && childrenByFolder.has(path)) {
          byId("folderUp").focus();
        } else {
          byId("folderPicker").open = false;
          byId("folderPicker").querySelector("summary").focus();
        }
      },"folder-option");
      const label = folderLabel(path);
      row.title = label;
      row.append(node("span","",search ? label.split("/").join(" / ") : label.split("/").pop()),
                 node("small","",String(folderCounts.get(path))));
      if (path === selectedFolder) row.setAttribute("aria-current","true");
      if (path && childrenByFolder.has(path)) {
        const arrow = node("span","folder-arrow","›");
        arrow.setAttribute("aria-hidden","true");
        row.append(arrow);
      }
      list.append(row);
    }
    if (search && !paths.length) list.append(node("p","folder-empty","No matching folders"));
  }

  function initFilters() {
    folderCounts.set("",items.length);
    folderCounts.set(unlinked,items.filter(item => !item.notes.length).length);
    const notes = new Set();
    for (const item of items) {
      const found = new Set();
      item.notes.forEach(note => {
        notes.add(note);
        noteFolders(note).forEach(folder => found.add(folder));
      });
      foldersById.set(item.id,found);
      for (const path of found) folderCounts.set(path,(folderCounts.get(path) || 0) + 1);
    }
    folderPaths = Array.from(folderCounts.keys()).filter(path => path && path !== unlinked)
      .sort((a,b) => a.startsWith("_") - b.startsWith("_") || a.localeCompare(b));
    for (const path of folderPaths) {
      const parent = folderParent(path);
      if (!childrenByFolder.has(parent)) childrenByFolder.set(parent,[]);
      childrenByFolder.get(parent).push(path);
    }
    byId("folderSearch").addEventListener("input",renderFolders);
    byId("folderUp").onclick = () => {
      chooseFolder(folderParent(selectedFolder));
      if (!selectedFolder) byId("folderSearch").focus();
    };
    renderFolders();
    for (const note of Array.from(notes).sort((a,b)=>a.localeCompare(b))) {
      const option = node("option");
      option.value = note;
      byId("notes").append(option);
    }
    ["kind","decision","reviewFilter","requester","query","note"].forEach(id => {
      byId(id).addEventListener(["query","note"].includes(id) ? "input" : "change", () => { page = 0; filter(); });
    });
    byId("reset").onclick = () => {
      ["kind","decision","reviewFilter","requester","query","note"].forEach(id => { byId(id).value = ""; });
      byId("folderPicker").open = false;
      chooseFolder("");
    };
  }
  function matchesReview(state,review) {
    if (review === "conflict") return state.reviewConflicts.length > 0;
    return !state.reviewConflicts.length && state.reviewStatus === review;
  }
  function filter() {
    const val = id=>byId(id).value.trim().toLowerCase();
    const kind = val("kind"), pick = val("decision"), text = val("query"), note = val("note");
    const review = byId("reviewFilter").value;
    const reviewerSelect = byId("requester");
    const requestedBy = reviewerSelect.value;
    const people = new Set();
    if (review) {
      for (const item of items) {
        const state = log.state(item.id);
        if (state.requestedBy && matchesReview(state,review)) people.add(state.requestedBy);
      }
    }
    reviewerSelect.replaceChildren(new Option("Everyone",""));
    for (const person of Array.from(people).sort()) reviewerSelect.add(new Option(person,person));
    reviewerSelect.value = people.has(requestedBy) ? requestedBy : "";
    byId("requesterLabel").hidden = !review;
    matches = items.filter(item => {
      if (kind && kind !== item.kind) return false;
      if (selectedFolder === unlinked ? item.notes.length > 0 : selectedFolder && !foldersById.get(item.id).has(selectedFolder)) return false;
      if (note && !item.notes.some(n=>n.toLowerCase().includes(note))) return false;
      if (text && ![item.label,item.vaultPath,...item.notes].some(n=>(n || "").toLowerCase().includes(text))) return false;
      const state = log.state(item.id);
      if (review && !matchesReview(state,review) || reviewerSelect.value && state.requestedBy !== reviewerSelect.value) return false;
      if (pick) {
        if (pick === "edits" && state.mode !== "edits" || pick === "conflict" && !state.conflicts.length) return false;
        const saved = state.choice ? state : null;
        if (pick === "open" && saved || pick === "original" && saved?.choice !== "original" || pick === "variant" && (!saved || saved.choice === "original")) return false;
      }
      return true;
    });
    let pos = matches.findIndex(i=>i.id === active);
    if (pos < 0) active = matches[0]?.id || "";
    else page = Math.floor(pos/pageSize);
    page = Math.min(page,Math.max(0,Math.ceil(matches.length/pageSize)-1));
    render();
  }
  function select(item) {
    if (!item) return;
    active = item.id;
    page = Math.floor(matches.indexOf(item)/pageSize);
    render();
  }
  function renderList() {
    byId("resultCount").textContent = matches.length.toLocaleString() + (matches.length === 1 ? " image" : " images");
    byId("pageNumber").textContent = matches.length ? (page+1) + " / " + Math.ceil(matches.length/pageSize) : "0";
    byId("back").disabled = page <= 0;
    byId("next").disabled = (page+1)*pageSize >= matches.length;
    byId("back").onclick = ()=>select(matches[(page-1)*pageSize]);
    byId("next").onclick = ()=>select(matches[(page+1)*pageSize]);
    const list = byId("list");
    list.replaceChildren();
    for (const item of matches.slice(page*pageSize,(page+1)*pageSize)) {
      const b = action("",()=>select(item),"entry" + (active === item.id ? " active" : ""));
      if (active === item.id) b.setAttribute("aria-current","true");
      const text = node("span");
      const state = log.state(item.id);
      const status = state.reviewConflicts.length ? "Conflicting reviews" : {requested:"Needs review",approved:"Approved",rejected:"Rejected"}[state.reviewStatus];
      text.append(node("strong","",item.label),node("small","",[describeChoice(item,state),status].filter(Boolean).join(" · ")));
      b.append(makeImage(item.thumbnail,"",true),text);
      list.append(b);
    }
  }
  const viewer = byId("viewer");
  const area = byId("viewer-area");
  const image = byId("viewer-image");
  let thumbnails = [];
  let position = 0;
  let openingThumbnail;

  function setActualSize(actual) {
    area.classList.toggle("actual",actual);
    const toggle = byId("viewer-zoom");
    toggle.setAttribute("aria-pressed",String(actual));
    toggle.textContent = actual ? "Fit to screen" : "Actual size";
    area.scrollLeft = actual ? (area.scrollWidth - area.clientWidth) / 2 : 0;
    area.scrollTop = actual ? (area.scrollHeight - area.clientHeight) / 2 : 0;
  }

  function showImage(next) {
    position = (next + thumbnails.length) % thumbnails.length;
    const thumb = thumbnails[position];
    const item = index.get(thumb.dataset.item);
    const key = thumb.dataset.key;
    const pick = byId("viewer-pick");
    pick.disabled = decision(item)?.choice === key;
    pick.textContent = pick.disabled ? "Selected" : key === "original" ? "Keep original" : "Use this version";
    image.alt = thumb.querySelector("img").alt;
    byId("viewer-caption").textContent = image.alt + " · " + (position + 1) + " of " + thumbnails.length;
    byId("viewer-original").href = thumb.href;
    byId("viewer-error").hidden = true;
    image.hidden = false;
    image.src = thumb.href;
    byId("viewer-zoom").disabled = false;
    setActualSize(false);
  }

  function openViewer(event) {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    openingThumbnail = event.currentTarget;
    thumbnails = Array.from(openingThumbnail.closest(".gallery").querySelectorAll("a.art"));
    byId("viewer-prev").disabled = byId("viewer-next").disabled = thumbnails.length === 1;
    viewer.showModal();
    showImage(thumbnails.indexOf(openingThumbnail));
  }

  byId("viewer-prev").onclick = () => showImage(position - 1);
  byId("viewer-next").onclick = () => showImage(position + 1);
  byId("viewer-close").onclick = () => viewer.close();
  byId("viewer-zoom").onclick = image.onclick = () => setActualSize(!area.classList.contains("actual"));
  byId("viewer-pick").onclick = () => {
    const thumb = thumbnails[position];
    viewer.close();
    save(index.get(thumb.dataset.item),thumb.dataset.key);
  };
  image.addEventListener("error", () => {
    if (!viewer.open || image.naturalWidth || !image.complete) return;
    image.hidden = true;
    byId("viewer-error").hidden = false;
    byId("viewer-zoom").disabled = true;
  });
  viewer.addEventListener("keydown", event => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    showImage(position + (event.key === "ArrowRight" ? 1 : -1));
  });
  viewer.addEventListener("close", () => {
    image.removeAttribute("src");
    const target = openingThumbnail.isConnected ? openingThumbnail :
      byId("detail").querySelector(".chosen .art, .art");
    target?.focus({preventScroll:true});
  });
  function card(item, key, variant) {
    const original = key === "original";
    const selected = decision(item)?.choice === key;
    const name = original ? "Original" : labelFor(item,key);
    const fig = node("figure","card" + (selected ? " chosen" : "") + (original ? " original" : ""));
    const cap = node("figcaption");
    cap.append(node("h3","",name));
    if (original || variant) {
      const thumb = node("a","art");
      thumb.href = url(original ? item.source : variant.path);
      thumb.dataset.item = item.id;
      thumb.dataset.key = key;
      thumb.setAttribute("aria-haspopup","dialog");
      thumb.setAttribute("aria-label","View " + name + " in lightbox");
      thumb.append(makeImage(original ? item.thumbnail : variant.path,item.label + " · " + name));
      thumb.addEventListener("click",openViewer);
      fig.append(thumb);
      if (selected) {
        const b = node("button","primary","✓ Selected");
        b.disabled = true; cap.append(b);
      } else if (original || setStatus(item) === "ready") cap.append(action(original ? "Keep original" : "Use this version",()=>save(item,key)));
      else cap.append(node("small","","Awaiting set review"));
    } else {
      const generated = outputs[item.id]?.generatedKeys?.includes(key);
      fig.append(node("div","pending-slot",generated ? "Generated · awaiting review" : "Awaiting image"));
    }
    fig.append(cap);
    return fig;
  }
  function renderDetail() {
    const article = byId("detail");
    article.replaceChildren();
    const item = index.get(active);
    if (!item) {
      article.append(node("p","empty","No illustrations match these filters."));
      return;
    }
    const pos = matches.indexOf(item), top = node("div","detail-top"), status = setStatus(item);
    const prepared = outputs[item.id]?.generatedKeys?.length;
    const statusLabel = status === "pending" && prepared
      ? prepared + " of " + treatments[item.kind].length + " generated · awaiting review" : statuses[status];
    top.append(node("span","status " + status,kinds[item.kind] + " · " + statusLabel));
    const nav = node("div","detail-nav");
    const prev = action("←",()=>select(matches[pos-1])), next = action("→",()=>select(matches[pos+1]));
    prev.setAttribute("aria-label","Previous illustration"); next.setAttribute("aria-label","Next illustration");
    prev.disabled = pos <= 0; next.disabled = pos+1 >= matches.length;
    nav.append(prev,node("span","",(pos+1) + " of " + matches.length.toLocaleString()),next); top.append(nav);
    article.append(top,node("h2","",item.label),node("p","path",item.vaultPath || item.source));
    if (item.notes.length) {
      const details=node("details","notes"), ul=node("ul");
      details.append(node("summary","",item.notes.length === 1 ? "Linked from " + item.notes[0].split("/").pop().replace(/\.md$/i,"") : "Linked from " + item.notes.length + " notes"));
      for (const note of item.notes) {
        const li=node("li"); li.append(action(note,()=>{ byId("note").value=note; filter(); },"text")); ul.append(li);
      }
      details.append(ul); article.append(details);
    } else article.append(node("p","notes","Unlinked image"));
    const bar = node("div","decision-bar"), current = decision(item);
    const label=node("span","","Decision · ");
    label.append(node("strong","",describeChoice(item,log.state(item.id))));
    bar.append(label);
    if (current) bar.append(action("Clear decision",()=>save(item,null),"text"));
    article.append(bar);
    const gallery=node("div","gallery");
    gallery.append(card(item,"original"));
    if (status === "missing") {
      gallery.append(node("div","empty","The " + treatments[item.kind].length + " planned versions will appear here as they become available."));
    } else {
      for (const [key] of treatments[item.kind]) gallery.append(card(item,key,reviewedVariant(item,key)));
    }
    article.append(gallery,window.renderReviewEditor({
      item, state:log.state(item.id), labelFor:key=>labelFor(item,key), onAction:action=>writeAction(item,action)
    }));
    const notes = outputs[item.id]?.notes;
    if (notes && (typeof notes === "string" || Array.isArray(notes))) {
      const details = node("details","qa");
      details.append(node("summary","","Visual review notes"),node("p","",Array.isArray(notes) ? notes.join("\n") : notes));
      article.append(details);
    }
  }
  function render() {
    renderList(); renderDetail();
    const count = items.filter(decision).length;
    byId("savedCount").textContent = count.toLocaleString() + (count === 1 ? " decision" : " decisions");
    byId("reviewCount").textContent = items.filter(item=>setStatus(item)==="ready").length.toLocaleString() + " of " + items.length.toLocaleString() + " sets reviewed";
    try { history.replaceState(null,"",active ? "#" + encodeURIComponent(active) : location.pathname); } catch {}
  }
  function exportDecisions() {
    log.refresh();
    const rows=[];
    for (const item of items) {
      const saved=decision(item);
      if (!saved) continue;
      const v=saved.choice === "original" ? null : reviewedVariant(item,saved.choice);
      rows.push({id:item.id,label:item.label,vaultPath:item.vaultPath,kind:item.kind,notes:item.notes,choice:saved.choice,mode:saved.mode,editNote:saved.editNote,
        selectionConflict:Boolean(saved.conflicts.length),reviewStatus:saved.reviewConflicts.length ? "conflict" : saved.reviewStatus,
        reviewComment:saved.reviewComment,requestedBy:saved.requestedBy,proposalAuthor:saved.proposalAuthor,
        sourceSha256:saved.sourceSha256,variantSha256:saved.variantSha256,updatedAt:saved.updatedAt,selectedPath:saved.conflicts.length ? null : v?.path || item.source});
    }
    const data={schemaVersion:2,events:log.events(),exportedAt:new Date().toISOString(),inventoryCount:items.length,decisions:rows};
    const blob=new Blob([JSON.stringify(data,null,2) + "\n"],{type:"application/json"});
    const href=URL.createObjectURL(blob), a=node("a");
    a.href=href; a.download="taelgar-art-decisions-" + data.exportedAt.slice(0,10) + ".json";
    document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(href),30000);
  }
  async function importDecisions(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.schemaVersion !== 2 || !Array.isArray(data.events)) throw Error("Choose an exported art review file.");
      log.refresh();
      const count = log.merge(data.events);
      notice("Imported " + count + " new history entries. Sync to share them.");
      filter();
    } catch(error) { notice(error.message || "Could not import decisions."); }
    byId("file").value="";
  }
  byId("export").onclick=exportDecisions;
  byId("import").onclick=()=>byId("file").click();
  byId("file").onchange=e=>importDecisions(e.target.files[0]);
  window.addEventListener("hashchange",() => {
    const item = index.get(decodeURIComponent(location.hash.slice(1)));
    if (matches.includes(item)) select(item);
  });
  let syncInProgress = false;
  async function syncReviews(pullOnly) {
    if (syncInProgress) return;
    syncInProgress = true;
    byId("sync").disabled = byId("pull").disabled = true;
    notice("Checking the shared GitHub review log…");
    let pulled = 0;
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        log.refresh();
        const response = await fetch("/sync",{
          method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({events:log.events(),pullOnly})
        });
        const result = await response.json();
        if (!response.ok) throw Error(result.error || "Could not sync.");
        pulled += log.merge(result.events);
        if (pullOnly || !result.events.length) {
          notice(pullOnly ? "Pulled " + pulled + " review entries."
            : "Sync complete. Pulled " + pulled + " and pushed " + result.pushed + " review entries.");
          return;
        }
      }
      throw Error("Other reviewers are still updating the log. Click Sync again.");
    } catch (error) {
      notice("Sync stopped. " + (error instanceof TypeError ? "Reopen the Python launcher and try again." : error.message));
    } finally {
      syncInProgress = false;
      byId("sync").disabled = byId("pull").disabled = false;
      filter();
    }
  }
  byId("sync").onclick = () => syncReviews(false);
  byId("pull").onclick = () => syncReviews(true);
  byId("reviewerName").value = localStorage.getItem(reviewerKey) || "";
  byId("reviewerName").onchange = e => localStorage.setItem(reviewerKey,e.target.value.trim());
  let storageTimer;
  window.addEventListener("storage",event=>{
    if (event.key === reviewerKey) byId("reviewerName").value = event.newValue || "";
    else if (event.key === null || event.key.startsWith(log.storagePrefix)) {
      clearTimeout(storageTimer);
      storageTimer = setTimeout(()=>{log.refresh();filter();},100);
    }
  });
  initFilters();
  filter();
  document.querySelector("main").hidden = false;
  document.querySelector(".actions").hidden = false;
  notice("");
}
startGallery().catch(error => {
  const message = document.getElementById("notice");
  message.textContent = "Could not open the gallery. " + error.message;
  message.hidden = false;
});
