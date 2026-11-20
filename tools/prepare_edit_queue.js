/* Refresh edit requests from the pulled checkout using the gallery's own decision rules. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const repo = path.resolve(__dirname, "..");
global.window = {};
require(path.join(repo, "gallery/review-log.js"));
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
const source = path.resolve(process.argv[2] || fs.readFileSync(path.join(repo, ".image-source"), "utf8").trim());
const target = path.resolve(source, "..", "restyle-edits");
const {items} = readJson(path.join(source, "inventory.json"));
const outputs = readJson(path.join(source, "outputs.json"));
const records = new Map();
const log = new window.ReviewLog(items, outputs, {
  length: 0, getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value)
});
const reviewDir = path.join(repo, "reviews");
for (const folder of fs.readdirSync(reviewDir, {withFileTypes: true})) {
  if (!folder.isDirectory()) continue;
  const dir = path.join(reviewDir, folder.name);
  log.merge(fs.readdirSync(dir).filter(f => f.endsWith(".json")).map(f => readJson(path.join(dir, f))));
}
const counts = {total: items.length, open: 0, conflicts: 0, stale: 0, awaitingReview: 0, rejected: 0};
const rows = [];
for (const item of items) {
  const state = log.state(item.id);
  if (!state.choice) counts.open++;
  if (state.conflicts.length || state.reviewConflicts.length) counts.conflicts++;
  if (state.staleProposalIds.length) counts.stale++;
  if (state.reviewStatus === "requested") counts.awaitingReview++;
  if (state.reviewStatus === "rejected") counts.rejected++;
  if (state.mode !== "edits" || !state.choice || state.conflicts.length || state.reviewConflicts.length ||
      state.staleProposalIds.length || ["requested", "rejected"].includes(state.reviewStatus)) continue;
  if (!state.editNote.trim()) throw Error("Missing instructions for " + item.id);
  const base = state.choice === "original" ? item.source : log.variant(item.id, state.choice).path;
  const baseHash = state.variantSha256 || item.sha256;
  const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(source, base))).digest("hex");
  if (actual !== baseHash) throw Error("The selected image has changed for " + item.id);
  rows.push({id:item.id, label:item.label, kind:item.kind, base, baseHash, request:state.proposalId,
    edit:state.editNote, choice:state.choice});
}
fs.mkdirSync(target, {recursive:true});
const temp = path.join(target, ".requests-" + crypto.randomUUID() + ".json");
fs.writeFileSync(temp, JSON.stringify(rows, null, 2) + "\n", {flag:"wx"});
fs.renameSync(temp, path.join(target, "requests.json"));
console.log({...counts, editRequests:rows.length});
