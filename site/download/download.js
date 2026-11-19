"use strict";

// Starts the download of the newest release, so these links never have to be updated
(async () => {
  const assets = {
    updater: /^SpE-ModUpdater\.bat$/,
    mod: /^SpE-ItemDisplay-.+\.jar$/,
    luckybattles: /^SpE-LuckyBattles-\d.+\.jar$/,
    "luckybattles-velocity": /^SpE-LuckyBattles-Velocity-.+\.jar$/,
  };
  const pattern = assets[document.documentElement.dataset.asset];
  const status = document.querySelector("#status");
  try {
    // Mehrere Mods teilen sich das Repository: die neueste Version mit der passenden Datei nehmen
    const response = await fetch("https://api.github.com/repos/HerobrineTV/SpE-ItemDisplay-Releases/releases?per_page=30");
    if (!response.ok) throw new Error(String(response.status));
    const releases = await response.json();
    let asset = null;
    for (const release of releases) {
      if (release.draft || release.prerelease) continue;
      asset = release.assets.find((item) => pattern.test(item.name));
      if (asset) break;
    }
    if (!asset) throw new Error("no asset");
    status.textContent = `${asset.name} wird heruntergeladen.`;
    document.querySelector("#manual").href = asset.browser_download_url;
    location.replace(asset.browser_download_url);
  } catch {
    status.textContent = "Der Download konnte nicht automatisch gestartet werden. Lade die Datei bitte über GitHub herunter.";
  }
})();
