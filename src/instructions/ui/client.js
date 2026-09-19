(() => {
  "use strict";
  const select = document.querySelector("#instruction-document");
  const editor = document.querySelector("#instruction-markdown");
  const save = document.querySelector("#instruction-save");
  const restore = document.querySelector("#instruction-restore");
  const status = document.querySelector("#instruction-status");
  if (!(select instanceof HTMLSelectElement) || !(editor instanceof HTMLTextAreaElement)) return;
  let documents = [];
  const current = () => documents.find(document => document.id === select.value);
  const show = () => { const document = current(); editor.value = document?.markdown ?? ""; status.textContent = document ? `Revision ${document.revision} · ${document.sha256}` : ""; };
  const load = async () => {
    const response = await fetch("/api/instructions", { headers: { accept: "application/json" } });
    if (!response.ok) { status.textContent = "Instructions are unavailable."; return; }
    documents = (await response.json()).documents;
    select.replaceChildren(...documents.map(item => { const option = window.document.createElement("option"); option.value = item.id; option.textContent = item.title; return option; }));
    show();
  };
  const mutate = async (path, token, value, method) => fetch(path, { method, headers: { "content-type": "application/json", "x-owner-action-token": token }, body: JSON.stringify(value) });
  select.addEventListener("change", show);
  save.addEventListener("click", async () => {
    const document = current(); if (!document) return;
    const response = await mutate("/api/instructions", save.dataset.token, { id: document.id, expectedRevision: document.revision, markdown: editor.value }, "PUT");
    const result = await response.json();
    if (!response.ok) { status.textContent = `Save failed: ${result.error}`; return; }
    documents = documents.map(item => item.id === result.document.id ? result.document : item); show();
  });
  restore.addEventListener("click", async () => {
    const document = current(); if (!document || !confirm("Replace this document with the reviewed repository default?")) return;
    const response = await mutate("/api/instructions/restore", restore.dataset.token, { id: document.id, expectedRevision: document.revision, confirmed: true }, "POST");
    const result = await response.json();
    if (!response.ok) { status.textContent = `Restore failed: ${result.error}`; return; }
    documents = documents.map(item => item.id === result.document.id ? result.document : item); show();
  });
  void load();
})();
