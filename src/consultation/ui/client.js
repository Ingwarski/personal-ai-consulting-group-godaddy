(() => {
  "use strict";
  const form = document.querySelector("#consultation-form");
  if (!(form instanceof HTMLFormElement)) return;
  const task = document.querySelector("#consultation-task");
  const consent = document.querySelector("#consultation-consent");
  const state = document.querySelector("#consultation-state");
  const messages = document.querySelector("#consultation-messages");
  const stop = document.querySelector("#consultation-stop");
  const exportButton = document.querySelector("#consultation-export");
  const deleteButton = document.querySelector("#consultation-delete");
  let requestId;
  let archiveId;
  let timer;
  const render = (view) => {
    const record = view?.record;
    state.textContent = record ? `Status: ${record.status}${record.errorCode ? ` (${record.errorCode})` : ""}` : "No consultation yet.";
    messages.replaceChildren();
    for (const message of view?.messages ?? []) {
      const article = document.createElement("article");
      const heading = document.createElement("h2");
      heading.textContent = `${message.role} · ${message.visibleTime}`;
      const body = document.createElement("pre");
      body.textContent = message.body;
      article.append(heading, body); messages.append(article);
    }
    requestId = record?.requestId;
    archiveId = record?.archiveId;
    const active = record && !["completed", "failed", "stopped"].includes(record.status);
    stop.disabled = !active;
    exportButton.disabled = !archiveId;
    deleteButton.disabled = !archiveId;
    if (active) { clearTimeout(timer); timer = setTimeout(refresh, 1500); }
  };
  const refresh = async () => {
    const suffix = requestId ? `?requestId=${encodeURIComponent(requestId)}` : "";
    const response = await fetch(`/api/consultations${suffix}`, { headers: { accept: "application/json" } });
    if (response.ok) render((await response.json()).consultation);
  };
  const mutate = async (path, token, value, method = "POST") => fetch(path, {
    method, headers: { "content-type": "application/json", "x-owner-action-token": token },
    body: JSON.stringify(value)
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    requestId = `req-${crypto.randomUUID()}`;
    const response = await mutate("/api/consultations", form.dataset.submitToken, { requestId, task: task.value, consent: consent.checked });
    const result = await response.json();
    if (!response.ok) { state.textContent = `Request rejected: ${result.error}`; return; }
    render({ record: result.record, messages: [] });
  });
  stop.addEventListener("click", async () => { if (requestId && confirm("Stop this consultation?")) { await mutate("/api/consultations/stop", stop.dataset.token, { requestId }); await refresh(); } });
  exportButton.addEventListener("click", async () => {
    if (!archiveId || !confirm("Export the complete decrypted archive to this browser?")) return;
    const response = await mutate("/api/archives/export", exportButton.dataset.token, { archiveId, confirmed: true });
    if (!response.ok) { state.textContent = `Export failed: ${(await response.json()).error}`; return; }
    const blob = await response.blob(); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${archiveId}.json`; link.click(); URL.revokeObjectURL(link.href);
  });
  deleteButton.addEventListener("click", async () => {
    if (!archiveId || !confirm("Permanently delete the complete encrypted archive? This cannot be undone.")) return;
    const response = await mutate("/api/archives/delete", deleteButton.dataset.token, { archiveId, confirmed: true });
    state.textContent = response.ok ? "Archive deleted." : `Delete failed: ${(await response.json()).error}`;
    if (response.ok) { archiveId = undefined; exportButton.disabled = true; deleteButton.disabled = true; }
  });
  void refresh();
})();
