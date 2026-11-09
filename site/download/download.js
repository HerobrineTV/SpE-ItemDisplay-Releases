"use strict";

// Starts the download of the newest release, so these links never have to be updated
(async () => {
  const assets = { updater: /^SpE-ModUpdater\.bat$/, mod: /^SpE-ItemDisplay-.+\.jar$/ };
  const pattern = assets[document.documentElement.dataset.asset];
  const status = document.querySelector("#status");
  try {
    const response = await fetch("https://api.github.com/repos/HerobrineTV/SpE-ItemDisplay-Releases/releases/latest");
    if (!response.ok) throw new Error(String(response.status));
    const release = await response.json();
    const asset = release.assets.find((item) => pattern.test(item.name));
    if (!asset) throw new Error("no asset");
    status.textContent = `${asset.name} wird heruntergeladen.`;
    document.querySelector("#manual").href = asset.browser_download_url;
    location.replace(asset.browser_download_url);
  } catch {
    status.textContent = "Der Download konnte nicht automatisch gestartet werden. Lade die Datei bitte über GitHub herunter.";
  }
})();
