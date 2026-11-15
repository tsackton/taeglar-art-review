"use strict";
(() => {
  const drafts = new Map();
  const openHistory = new Set();
  const reviewLabels = {
    none: "No review requested", requested: "Needs review",
    approved: "Approved", rejected: "Rejected"
  };
  const reviewVerbs = {requested:"Requested review", approved:"Approved", rejected:"Rejected"};
  const dateFormat = new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"});

  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function dateStamp(event) {
    const el = element("time");
    el.dateTime = event.at;
    const date = new Date(event.at);
    if (Number.isFinite(date.getTime())) el.textContent = dateFormat.format(date);
    return el;
  }

  function attribution(event) {
    const by = element("span","review-byline");
    by.append(element("strong","",event.author || "Unknown reviewer"), dateStamp(event));
    return by;
  }

  function entry(event, title, text) {
    const block = element("li","review-entry");
    block.append(element("strong","review-event-name",title),attribution(event));
    if (text) block.append(element("p","review-text",text));
    return block;
  }

  window.renderReviewEditor = function renderReviewEditor({item,state,labelFor,onAction}) {
    const editor = element("section","review-editor");
    editor.setAttribute("aria-label","Decisions and collaboration");
    editor.dataset.item = item.id;
    const message = element("p","review-message");
    message.setAttribute("role","alert");
    const expected = {proposalId:state.proposalId,requestId:state.requestId};
    const history = state.history;
    const eventById = new Map(history.map(event => [event.id,event]));
    const proposal = eventById.get(state.proposalId);
    const choiceName = key => key === "original" ? "Original" : key ? labelFor(key) : "Undecided";
    const choiceDescription = event => choiceName(event.choice) + (event.mode === "edits" ? " · Use with edits" : "");

    function draftField(label, key, value, placeholder) {
      const wrapper = element("label","review-field",label);
      const input = element("textarea");
      input.rows = 2;
      input.placeholder = placeholder;
      const storageKey = item.id + "/" + key;
      input.dataset.draft = storageKey;
      input.value = drafts.get(storageKey) ?? value;
      input.addEventListener("input",() => drafts.set(storageKey,input.value));
      wrapper.append(input);
      return {wrapper,input};
    }

    // Remove drafts before a successful action triggers a synchronous gallery redraw.
    // If saving is declined or fails, restore the text in whichever render is current.
    async function submit(action, fields, button) {
      if (button.disabled) return;
      const captured = fields.map(field => [field.dataset.draft,field.value]);
      captured.forEach(([key]) => drafts.delete(key));
      button.disabled = true;
      message.textContent = "";
      try {
        const saved = await onAction(action);
        if (saved === false) {
          restore();
          return;
        }
        for (const field of fields) {
          if (field.isConnected && !drafts.has(field.dataset.draft)) field.value = "";
        }
      } catch (error) {
        restore();
        const active = document.querySelector(".review-editor");
        if (active?.dataset.item === item.id) active.querySelector(".review-message").textContent = error.message || "Could not save this change.";
      } finally {
        button.disabled = false;
      }
      function restore() {
        for (const [key,value] of captured) {
          if (drafts.has(key)) continue;
          drafts.set(key,value);
          const current = document.querySelector('.review-editor [data-draft="' + CSS.escape(key) + '"]');
          if (current) current.value = value;
        }
      }
    }

    function button(label, click, className = "") {
      const b = element("button",className,label);
      b.type = "button";
      b.addEventListener("click",() => click(b));
      return b;
    }

    function choose(event, b, field) {
      submit({type:"choice",choice:event.choice,mode:event.mode,editNote:event.editNote || "",
              expectedProposalId:state.proposalId,expectedVariantSha256:Object.hasOwn(event,"variantSha256") ? event.variantSha256 : state.variantSha256},field ? [field] : [],b);
    }

    if (state.conflicts.length) {
      const conflict = element("section","review-conflict");
      conflict.append(element("h3","","Resolve competing decisions"));
      const list = element("ul","review-entries");
      for (const event of [proposal,...state.conflicts].filter(Boolean)) {
        const row = entry(event,choiceDescription(event),event.editNote);
        if (state.staleProposalIds?.includes(event.id)) {
          row.append(element("small","review-byline","This version has since changed."));
        } else {
          row.append(button("Keep this decision",b => choose(event,b)));
        }
        list.append(row);
      }
      conflict.append(list);
      editor.append(conflict);
    }

    if (state.staleChoice) {
      editor.append(element("p","review-conflict","The selected artwork has changed. Choose a current version to continue its review."));
    }
    if (state.choice) {
      const treatment = element("section","review-block");
      const heading = element("h3","","Edit instructions");
      const instructions = draftField("Edits for " + choiceName(state.choice),
        "edits/" + state.proposalId,state.mode === "edits" ? state.editNote || "" : "",
        "Describe what needs to change in this version");
      const buttons = element("div","review-buttons");
      const saveEdits = button(state.mode === "edits" ? "Save edit instructions" : "Use with edits",b => {
        const editNote = instructions.input.value.trim();
        choose({choice:state.choice,mode:"edits",editNote},b,instructions.input);
      });
      buttons.append(saveEdits);
      if (state.mode === "edits") {
        const checkChanged = () => { saveEdits.disabled = instructions.input.value.trim() === state.editNote; };
        checkChanged();
        instructions.input.addEventListener("input",checkChanged);
        buttons.append(button("Use as is",b => choose({choice:state.choice,mode:"use"},b,instructions.input)));
      }
      treatment.append(heading,instructions.wrapper,buttons);
      editor.append(treatment);
    }

    const review = element("section","review-block");
    const heading = element("div","review-section-title");
    heading.append(element("h3","","Collaborator review"),
                   element("span","review-state state-" + state.reviewStatus,reviewLabels[state.reviewStatus]));
    review.append(heading);
    const thread = history.filter(event =>
      state.requestId && (event.id === state.requestId || event.requestId === state.requestId));
    if (thread.length) {
      const discussion = element("ul","review-entries");
      for (const event of thread) {
        discussion.append(entry(event,reviewVerbs[event.status] || "Reply",event.text));
      }
      review.append(discussion);
    }
    if (state.reviewConflicts.length) {
      const conflict = element("div","review-conflict");
      conflict.append(element("strong","","Competing review responses"));
      const otherThreads = state.reviewConflicts.filter(event => !thread.includes(event));
      if (otherThreads.length) {
        const list = element("ul","review-entries");
        for (const event of otherThreads) list.append(entry(event,reviewVerbs[event.status],event.text));
        conflict.append(list);
      }
      conflict.append(element("p","review-text","Approve or reject to resolve the responses."));
      review.append(conflict);
    }
    const reviewText = draftField("Review comment","review/" + (state.proposalId || "open") + "/" + (state.requestId || "new"),
      "",state.reviewStatus === "none" ? "What should a collaborator check?" : "Add a reply or explain your review decision");
    const reviewButtons = element("div","review-buttons");
    function statusButton(label,status) {
      return button(label,b => submit({type:"review",status,text:reviewText.input.value.trim(),expected},
        [reviewText.input],b));
    }
    if (!state.staleChoice && state.reviewStatus !== "requested") reviewButtons.append(statusButton("Request review","requested"));
    if (state.reviewStatus === "requested" || state.reviewConflicts.length) {
      reviewButtons.append(statusButton("Approve","approved"),statusButton("Reject","rejected"));
    }
    if (state.requestId) {
      reviewButtons.append(button("Post reply",b => {
        const text = reviewText.input.value.trim();
        if (!text) { reviewText.input.focus(); return; }
        submit({type:"comment",text,requestId:state.requestId},[reviewText.input],b);
      }));
    }
    if (reviewButtons.childElementCount) review.append(reviewText.wrapper,reviewButtons);
    editor.append(review);

    const notes = element("section","review-block");
    notes.append(element("h3","","Image notes"));
    const general = state.comments.filter(event => !event.requestId);
    if (general.length) {
      const list = element("ul","review-entries");
      for (const event of general) {
        const row = element("li","review-entry");
        row.append(attribution(event),element("p","review-text",event.text));
        list.append(row);
      }
      notes.append(list);
    }
    const note = draftField("New image note","image-note","","Add a note about this illustration");
    notes.append(note.wrapper,button("Post note",b => {
      const text = note.input.value.trim();
      if (!text) { note.input.focus(); return; }
      submit({type:"comment",text},[note.input],b);
    }));
    editor.append(notes);

    if (history.length) {
      const details = element("details","review-history");
      details.open = openHistory.has(item.id);
      details.addEventListener("toggle",() => {
        if (!details.isConnected) return;
        if (details.open) openHistory.add(item.id);
        else openHistory.delete(item.id);
      });
      details.append(element("summary","","Decision and review history (" + history.length + ")"));
      const list = element("ol","review-entries");
      for (const event of [...history].reverse()) {
        const related = eventById.get(event.proposalId);
        if (event.type === "choice") {
          list.append(entry(event,event.choice ? choiceDescription(event) : "Cleared selection",event.editNote));
        } else {
          const action = reviewVerbs[event.status] || (event.requestId ? "Reply" : "Image note");
          const title = related ? action + " · " + choiceDescription(related) : action;
          list.append(entry(event,title,event.text));
        }
      }
      details.append(list);
      editor.append(details);
    }
    editor.append(message);
    return editor;
  };
})();
