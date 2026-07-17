async function refresh() {
  const status = (await chrome.runtime.sendMessage({ type: "get_status" })) as {
    paired: boolean;
    enabled_domains: string[];
  };
  document.getElementById("pairing")!.hidden = status.paired;
  document.getElementById("domains")!.hidden = !status.paired;
  const list = document.getElementById("enabled-list")!;
  list.innerHTML = "";
  for (const domain of status.enabled_domains) {
    const li = document.createElement("li");
    li.textContent = `${domain} `;
    const btn = document.createElement("button");
    btn.textContent = "stop";
    btn.className = "secondary";
    btn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "disable_domain", domain });
      await refresh();
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

document.getElementById("pair")!.addEventListener("click", async () => {
  const token = (document.getElementById("token") as HTMLInputElement).value.trim();
  const statusEl = document.getElementById("pair-status")!;
  if (!token) {
    statusEl.textContent = "Paste the token first.";
    statusEl.className = "err";
    return;
  }
  const result = (await chrome.runtime.sendMessage({ type: "pair", token })) as {
    ok: boolean;
    error?: string;
  };
  statusEl.textContent = result.ok ? "Paired!" : `Pairing failed: ${result.error}`;
  statusEl.className = result.ok ? "ok" : "err";
  // The one-time token is cleared immediately either way.
  (document.getElementById("token") as HTMLInputElement).value = "";
  if (result.ok) await refresh();
});

document.getElementById("enable-current")!.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;
  const domain = new URL(tab.url).hostname;
  await chrome.runtime.sendMessage({ type: "enable_domain", domain });
  await refresh();
});

void refresh();
