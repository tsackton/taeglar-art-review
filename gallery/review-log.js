"use strict";
(() => {
  const prefix = "taelgar-vault-restyle:event:v1:";
  const oldKey = "taelgar-vault-restyle:decisions:v1";
  const hash = /^[a-f0-9]{64}$/;
  const eventId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,219}$/;
  const itemId = /^(?:catalog-[0-9]+|vault-[a-f0-9]+)$/;
  const choices = new Set(["original","plain-faithful","plain-corrected","setting-faithful",
    "setting-corrected","light-faithful","light-corrected","dark-faithful","dark-corrected",
    "faithful","light-correction","full-correction"]);
  const contains = (object,key) => Object.prototype.hasOwnProperty.call(object,key);
  function requireValue(ok,message) {
    if (!ok) throw new Error(message);
  }
  function string(value,max = 32000) {
    return typeof value === "string" && value.length <= max;
  }
  function compare(a,b) {
    return a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
  function validRef(value) {
    return typeof value === "string" && eventId.test(value);
  }
  function canonical(raw) {
    requireValue(raw && validRef(raw.id) && typeof raw.itemId === "string" && itemId.test(raw.itemId),
      "A review record has an invalid ID.");
    requireValue(typeof raw.sourceSha256 === "string" && hash.test(raw.sourceSha256)
      && string(raw.author,200) && string(raw.at,40) && Number.isFinite(Date.parse(raw.at)),
      "A review record has invalid image or author information.");
    const e = {id:raw.id,itemId:raw.itemId,type:raw.type,at:new Date(raw.at).toISOString(),
      author:raw.author,sourceSha256:raw.sourceSha256};
    if (e.type === "choice" || e.type === "review") {
      requireValue(Array.isArray(raw.parents) && raw.parents.every(validRef) && !raw.parents.includes(e.id),
        "A review record has invalid revision links.");
      e.parents = [...new Set(raw.parents)].sort();
    }
    if (e.type === "choice") {
      requireValue((raw.choice === null || choices.has(raw.choice)) && ["use","edits"].includes(raw.mode)
        && string(raw.editNote) && (raw.choice !== null || raw.mode === "use")
        && (raw.choice === null || raw.choice === "original" ? raw.variantSha256 === null :
          typeof raw.variantSha256 === "string" && hash.test(raw.variantSha256)),
        "A selection has an invalid version or fingerprint.");
      Object.assign(e,{choice:raw.choice,mode:raw.mode,editNote:raw.editNote,variantSha256:raw.variantSha256});
    } else if (e.type === "review" || e.type === "comment") {
      requireValue(string(raw.text) && (raw.proposalId === null || validRef(raw.proposalId))
        && (raw.requestId === null || validRef(raw.requestId)), "A comment has invalid review information.");
      Object.assign(e,{text:raw.text,proposalId:raw.proposalId,requestId:raw.requestId});
      if (e.type === "review") {
        requireValue(["requested","approved","rejected"].includes(raw.status) &&
          (raw.status === "requested" ? e.requestId === null : !!e.requestId), "Invalid review status or request.");
        e.status = raw.status;
      } else {
        requireValue(e.text.trim().length > 0,"Enter a comment first.");
      }
    } else throw new Error("Unrecognized review record type.");
    return e;
  }

  // A proposal or verdict tells us exactly which competing revisions its author saw.
  // Arrival order (including sync retries) never chooses a winner.
  function heads(events) {
    const superseded = new Set(events.flatMap(e => e.parents));
    return events.filter(e => !superseded.has(e.id));
  }
  function choiceHeads(events) {
    const all = events.filter(e => e.type === "choice");
    const legacy = all.filter(e => e.id.startsWith("legacy-")).at(-1);
    if (!legacy) return heads(all);
    // V1 backups only carried timestamps. A legacy choice is a baseline and cannot resurrect
    // a selection cleared or replaced by a later native change.
    const native = all.filter(e => !e.id.startsWith("legacy-"));
    const nativeHeads = heads(native);
    if (native.some(e => e.parents.includes(legacy.id))) return nativeHeads;
    const newer = nativeHeads.filter(e => e.at >= legacy.at);
    return newer.length ? newer : [legacy];
  }

  function summarizeReviews(history,proposalId) {
    const events = history.filter(e => e.type === "review" && e.proposalId === proposalId);
    const requests = events.filter(e => e.status === "requested");
    const byId = new Map(events.map(e => [e.id,e]));
    const superseded = new Set();
    for (const event of events) {
      for (const id of event.parents) {
        const previous = byId.get(id);
        const priorRequest = previous?.requestId || previous?.id;
        if (priorRequest && priorRequest !== event.requestId) superseded.add(priorRequest);
      }
    }
    const liveRequests = requests.filter(e => !superseded.has(e.id));
    const request = liveRequests.at(-1);
    const verdicts = request ? heads(events.filter(e => e.requestId === request.id)) : [];
    return {request,liveRequests,verdicts,latest:verdicts.at(-1) || request};
  }

  class ReviewLog {
    constructor(items,outputs,storage = localStorage) {
      this.storage = storage;
      this.items = new Map(items.map(item => [item.id,item]));
      this.outputs = outputs;
      this.records = new Map();
      this.byItem = new Map();
      this.cache = new Map();
      this.refresh();
      const old = storage.getItem(oldKey);
      if (old) {
        const parsed = JSON.parse(old);
        requireValue(parsed && typeof parsed === "object" && !Array.isArray(parsed),"Invalid saved v1 decisions.");
        this.importLegacy(Object.entries(parsed).map(([id,row]) => ({...row,id})));
      }
    }
    static get storagePrefix() { return prefix; }
    remember(e) {
      this.records.set(e.id,e);
      if (!this.byItem.has(e.itemId)) this.byItem.set(e.itemId,[]);
      this.byItem.get(e.itemId).push(e);
      this.cache.delete(e.itemId);
    }
    refresh() {
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (!key?.startsWith(prefix) || this.records.has(key.slice(prefix.length))) continue;
        const saved = this.storage.getItem(key);
        if (saved === null) continue;
        const e = canonical(JSON.parse(saved));
        requireValue(key === prefix + e.id,"A stored review has a mismatched ID.");
        this.remember(e);
      }
    }
    events() { return [...this.records.values()].sort(compare); }
    merge(rawEvents) {
      requireValue(Array.isArray(rawEvents),"Expected a list of review records.");
      const batch = new Map();
      for (const raw of rawEvents) {
        const e = canonical(raw);
        let known = batch.get(e.id) || this.records.get(e.id);
        if (!known) {
          const saved = this.storage.getItem(prefix + e.id);
          if (saved !== null) known = canonical(JSON.parse(saved));
        }
        if (known) requireValue(JSON.stringify(e) === JSON.stringify(known),
          "Two different review records share the same ID. Sync stopped to protect both.");
        batch.set(e.id,e);
      }
      let added = 0;
      for (const e of batch.values()) {
        if (this.records.has(e.id)) continue;
        this.storage.setItem(prefix + e.id,JSON.stringify(e));
        this.remember(e);
        added++;
      }
      return added;
    }
    variant(itemId,key) {
      const output = this.outputs[itemId];
      return output?.reviewed && output.variants.find(v => v.key === key);
    }
    state(id) {
      if (this.cache.has(id)) return this.cache.get(id);
      const item = this.items.get(id);
      requireValue(item,"Unknown illustration.");
      const history = (this.byItem.get(id) || []).filter(e => e.sourceSha256 === item.sha256).sort(compare);
      const proposals = choiceHeads(history);
      const p = proposals.at(-1);
      const staleProposalIds = proposals.filter(e => e.choice && e.choice !== "original" &&
        this.variant(id,e.choice)?.sha256 !== e.variantSha256).map(e => e.id);
      const valid = !staleProposalIds.includes(p?.id);
      const proposalId = p?.id || null;
      const reviews = summarizeReviews(history,proposalId);
      const latest = valid && reviews.latest;
      const state = {choice:valid ? p?.choice || null : null,mode:valid ? p?.mode || "use" : "use",
        editNote:valid ? p?.editNote || "" : "",proposalId,proposalAuthor:p?.author || "",
        updatedAt:p?.at || null,sourceSha256:item.sha256,variantSha256:valid ? p?.variantSha256 || null : null,
        reviewStatus:latest?.status || "none",reviewComment:latest?.text || "",
        requestId:valid ? reviews.request?.id || null : null,requestedBy:valid ? reviews.request?.author || "" : "",
        comments:history.filter(e => e.type === "comment"),history,conflicts:proposals.slice(0,-1),
        reviewConflicts:valid ? [...reviews.liveRequests.slice(0,-1),...reviews.verdicts.slice(0,-1).filter(e => e.status !== latest.status)] : [],
        staleChoice:!valid,staleProposalIds};
      this.cache.set(id,state);
      return state;
    }
    append(itemId,type,author,fields) {
      const item = this.items.get(itemId);
      requireValue(item,"Unknown illustration.");
      const e = {id:crypto.randomUUID(),itemId,type,at:new Date().toISOString(),author:author || "",
        sourceSha256:item.sha256,...fields};
      this.merge([e]);
      return this.state(itemId);
    }
    choose(id,choice,options = {}) {
      const state = this.state(id);
      if (contains(options,"expectedProposalId")) requireValue(options.expectedProposalId === state.proposalId,
        "The selection changed. Check the latest version and try again.");
      const variant = choice && choice !== "original" && this.variant(id,choice);
      requireValue(!choice || choice === "original" || variant,"That version is unavailable.");
      if (options.expectedVariantSha256 !== undefined) requireValue(options.expectedVariantSha256 === (variant?.sha256 || null),
        "The selected image has changed. Inspect the current version before selecting it.");
      return this.append(id,"choice",options.author,{choice,mode:options.mode || "use",editNote:options.editNote || "",
        variantSha256:variant?.sha256 || null,parents:choiceHeads(state.history).map(e => e.id)});
    }
    review(id,status,text = "",author = "",expected = {}) {
      const state = this.state(id);
      if (contains(expected,"proposalId")) requireValue(expected.proposalId === state.proposalId,
        "The selection changed. Check it before reviewing.");
      if (contains(expected,"requestId")) requireValue(expected.requestId === state.requestId,
        "The review request changed. Check it before responding.");
      requireValue(!state.staleChoice,"Select a current version before submitting a review.");
      const reviews = summarizeReviews(state.history,state.proposalId);
      const request = status === "requested";
      requireValue(request || reviews.request,"Request a review before approving or rejecting it.");
      const parents = [...reviews.liveRequests,...reviews.verdicts];
      return this.append(id,"review",author,{status,text,proposalId:state.proposalId,
        requestId:request ? null : reviews.request.id,parents:parents.map(e => e.id)});
    }
    comment(id,text,author = "",context = {}) {
      let {requestId = null,proposalId = null} = context;
      const {history} = this.state(id);
      if (requestId) {
        const request = history.find(e => e.id === requestId && e.type === "review" && e.status === "requested");
        requireValue(request && (!proposalId || request.proposalId === proposalId),"The comment refers to an unknown review.");
        proposalId = request.proposalId;
      }
      if (proposalId) requireValue(history.some(e => e.id === proposalId && e.type === "choice"),
        "The comment refers to an unknown selection.");
      return this.append(id,"comment",author,{text:text.trim(),proposalId,requestId});
    }
    importLegacy(rows) {
      requireValue(Array.isArray(rows),"Expected a list of saved decisions.");
      let count = 0, skipped = 0;
      for (const row of rows) {
        const item = this.items.get(row?.id);
        if (!item || item.sha256 !== row.sourceSha256 || !string(row.updatedAt,40) ||
            !Number.isFinite(Date.parse(row.updatedAt)) || !choices.has(row.choice) ||
            (row.choice !== "original" && (!hash.test(row.variantSha256) || this.variant(row.id,row.choice)?.sha256 !== row.variantSha256))) {
          skipped++; continue;
        }
        const at = new Date(row.updatedAt).toISOString();
        const variantSha256 = row.choice === "original" ? null : row.variantSha256;
        const id = ["legacy",item.id,Date.parse(at).toString(36),row.choice,item.sha256,variantSha256 || "original"].join("-");
        if (this.records.has(id)) continue;
        const state = this.state(item.id);
        if (state.proposalId && state.updatedAt > at) { skipped++; continue; }
        count += this.merge([{id,itemId:item.id,type:"choice",at,author:"Imported decision",sourceSha256:item.sha256,
          choice:row.choice,mode:"use",editNote:"",variantSha256,parents:[]}]);
      }
      return {count,skipped};
    }
  }
  window.ReviewLog = ReviewLog;
})();
