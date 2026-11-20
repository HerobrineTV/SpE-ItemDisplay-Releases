# SpE-ItemDisplay-Releases
Releases of the SpE ItemDisplay Fabric mod. Run SpE-ModUpdater.bat to install or update it.

## Update-Prüfung aller SpE-Mods und -Plugins (`site/versions.json`)

Alle Mods und Plugins fragen beim Start (Plugins zusätzlich alle 6 Stunden, Mods beim Betreten nach 30 Minuten
erneut) diese Datei ab:

```
https://raw.githubusercontent.com/HerobrineTV/SpE-ItemDisplay-Releases/main/site/versions.json
```

Ist dort eine höhere Version eingetragen als installiert:

| Was | Wer bekommt die Meldung |
|---|---|
| Mods (SpE ItemDisplay, SpE Lucky Battles, Lucky One Block) | jeder Spieler mit der Mod, bei jedem Betreten einer Welt oder eines Servers im Chat; auf dedizierten Servern (Forge) OPs beim Betreten und die Konsole |
| Paper-Plugins (SpE-Lobby, SpE-Challenges) | OPs und Spieler mit den Admin-Rechten des Plugins beim Betreten, die Konsole |
| Velocity-Plugins (SpE-LuckyBattles-Velocity, SpE-Chat) | Spieler mit den Admin-Rechten des Plugins (LuckPerms) beim Betreten, die Proxy-Konsole |

Die Meldung zeigt installierte und neue Version und einen anklickbaren Download-Link (`download`).

**Bei jedem Release:** neue Version bauen und veröffentlichen, dann hier `version` (und falls nötig `download`)
hochziehen und pushen. Erst danach sehen alle die Meldung, also die Datei nie vor dem Release erhöhen.

| Schlüssel | Projekt | Rechte für die Meldung |
|---|---|---|
| `spe-itemdisplay` | SpE-ItemDisplay (Fabric) | alle mit der Mod |
| `spe-luckybattles` | SpE-LuckyBattles, Mod (Forge 1.8.9) | alle mit der Mod, OPs auf dem Server |
| `spe-luckybattles-velocity` | SpE-LuckyBattles, `velocity-bridge` | `spe_luckybattles.update`, `spe_luckybattles.settings` |
| `spe-lobby` | SpE-LuckyBattles, `lobby-plugin` | OP, `spelobby.admin`, `spelobby.update` |
| `spe-challenges` | SpE-Challenges | OP, `spe-ch.settings`, `spe-ch.update` |
| `spe-chat` | SpE-Chat | `spechat.admin`, `spechat.update` |
| `lucky-oneblock` | LuckyOneBlock189Mod | alle mit der Mod, OPs auf dem Server |

Zum Testen nimmt jedes Projekt eine andere Adresse mit `-Dspe.updates.url=http://...` an.
