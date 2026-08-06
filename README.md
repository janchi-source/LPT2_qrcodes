# LPT2 — Rozdeľovacia hra (doobedie)

Logistická appka na správu rozdeľovacej hry: 10 skupín, 10 stanovíšť (A–J v kruhu),
deti s QR náramkami sa postupne „rozdeľujú“ do svojich domovských skupín.

## Kde to beží

Appka vie bežať dvoma spôsobmi a prepína sa sama podľa premenných prostredia:

| režim | úložisko | kedy použiť |
|---|---|---|
| **lokálne** (default) | JSON súbory v `data/` | tábor bez internetu — notebook v lokálnej WiFi |
| **Vercel** | Vercel KV / Upstash Redis | keď je na mieste internet |

Hlavný rozdiel z pohľadu animátora: na Vercele má stránka **dôveryhodný
certifikát**, takže kamera funguje hneď a netreba nič inštalovať do telefónov.
Lokálne treba raz na každý telefón nainštalovať certifikát (viď nižšie).

Lokálny režim ale beží aj bez internetu — ak vypadne signál, hra pokračuje.
Na Vercele sa pri výpadku skenovanie zastaví.

## Nasadenie na Vercel

1. Nahraj projekt do gitu a naimportuj ho na Vercel (framework: **Other**,
   žiadny build command — je to nastavené vo `vercel.json`).
2. V projekte: **Storage → Create → Upstash Redis** a priraď ho k projektu.
   Vercel doplní premenné `KV_REST_API_URL` a `KV_REST_API_TOKEN`; appka si
   ich nájde sama a prepne sa do KV režimu.
3. Deploy. Skener je na `https://<tvoj-projekt>.vercel.app/scan.html`.
4. Deti naimportuj cez **Nastavenia** priamo na hostingu. Ak ich máš už
   lokálne v `data/`, vieš ich nahrať jedným príkazom:

```bash
KV_REST_API_URL=... KV_REST_API_TOKEN=... npm run push-to-kv
```

**Čo je kde:** `api/[...path].js` je vstupný bod pre Vercel, `server.js` pre
lokálne spustenie — obidva používajú to isté routovanie z `lib/handler.js`.
`.vercelignore` zabraňuje nahraniu `certs/` (privátne kľúče!) a `data/`.

### Overenie, že databáza je pripojená

Otvor `https://<projekt>.vercel.app/api/server-info`. Táto adresa funguje
**aj bez databázy**, práve preto, aby sa dalo diagnostikovať:

- `"storage": "kv"` → databáza je pripojená, všetko je v poriadku,
- `"storage": "file"` → appka databázu nevidí; v `kv_env` je vidno, ktorá
  premenná chýba (zobrazuje sa len `true`/`false`, nikdy hodnota).

Najčastejšia príčina, keď sú premenné nastavené a aj tak to nejde: **premenné
sa prejavia až v novom nasadení** — treba spustiť Redeploy.

### Súbežnosť (dôležité)

Lokálne je Node jednovláknový a celá herná logika je synchrónna, takže
čítaj-uprav-zapíš dobehne bez prerušenia. Na Vercele obsluhuje jedna inštancia
viac požiadaviek naraz a inštancií môže bežať viac — dvaja animátori skenujúci
v tej istej sekunde by si inak prepísali zápis a jeden sken by zmizol.

Preto v KV režime beží každá požiadavka ako transakcia (`store.runTransaction`):
načíta sa celý stav, herná logika ho synchrónne upraví v pamäti (kontext je
oddelený cez `AsyncLocalStorage`) a zapíše sa jedným atomickým
compare-and-swap zápisom. Keď medzitým zapísal niekto iný, zápis neprejde
a celá požiadavka sa zopakuje nad čerstvými dátami (max 6 pokusov, potom
animátor dostane zrozumiteľnú hlášku „skús ešte raz“).

Testuje to `test/store.test.js` proti falošnému Redisu: 10 súbežných skenov,
z toho väčšina musí zápis opakovať, a napriek tomu sa žiadny nestratí ani
nezduplikuje.

## Spustenie lokálne

```bash
node server.js
```

Nič viac. **Žiadne npm závislosti** — zámerne čistý Node.js (namiesto Express),
aby sa appka dala na tábore spustiť na hocijakom notebooku bez internetu:
skopíruješ priečinok, spustíš `node server.js`, hotovo. QR knižnice
(html5-qrcode, qrcodejs) sú stiahnuté lokálne v `public/vendor/`.

- **http://localhost:3000** — admin/nastavenia na notebooku
- **https://IP-NOTEBOOKU:3443/scan.html** — skenovanie na mobiloch (IP vypíše server pri štarte)

### HTTPS a kamera na mobiloch (dôležité!)

Prehliadače pustia ku kamere len na **zabezpečenej adrese, ktorej telefón verí**.
Nestačí „preklikať varovanie“ — pri nedôveryhodnom certifikáte Safari aj Chrome
kameru zablokujú, aj keď sa stránka načíta.

`bash scripts/gen-certs.sh` preto vyrobí dva certifikáty:

- `certs/ca.pem` — lokálna certifikačná autorita; **tá sa raz nainštaluje do
  každého telefónu** (server ju ponúka na `/ca.crt`, návod je na `/pomoc.html`),
- `certs/cert.pem` — certifikát servera, podpísaný tou CA a platný pre **všetky
  LAN adresy tohto počítača** (skript si ich sám zistí).

Postup pre animátorov (raz na telefón):

1. otvoriť `https://<IP>:3443/pomoc.html` (stránka ukáže aj QR kód pre ostatných),
2. stiahnuť certifikát tlačidlom,
3. **iPhone**: Nastavenia → Profil prevzatý → Inštalovať, a potom Nastavenia →
   Všeobecné → Info → **Nastavenia dôvery certifikátov** → zapnúť „LPT2 tabor CA“
   (tento krok sa nesmie vynechať),
4. **Android**: Nastavenia → Zabezpečenie → Šifrovanie a poverenia →
   Inštalovať certifikát → **Certifikát CA**.

Ak sa IP adresa notebooku zmení (iná sieť), spusti `gen-certs.sh` znova
a certifikát na telefónoch preinštaluj.

Skenovacia stránka si prostredie kontroluje sama: keď je otvorená cez `http://`
alebo v nezabezpečenom kontexte, zobrazí oranžové upozornenie s odkazom na
správnu `https://` adresu, resp. na návod. Chyby kamery hlási po slovensky
(zamietnuté povolenie, kameru drží iná appka, kamera sa nenašla) a ak zlyhá
`facingMode`, skúsi zadnú kameru vybrať zo zoznamu. Núdzovo sa dá kód
z náramku vždy zadať ručne.

## Stránky

| URL | Účel |
|---|---|
| `/` | rozcestník + stav hry |
| `/scan.html` | **mobil, animátori**: výber stanovišťa/skupiny, skenovanie QR, ukončenie kola |
| `/admin.html` | prehľad detí a skupín, filtre, manuálny override, log, ovládanie hry |
| `/settings.html` | počty, stanovištia, mapovanie skupina→stanovište, bait prah, pridávanie/import detí |
| `/qr.html` | QR kódy všetkých detí na tlač |

## Dizajn skenovacej stránky

Skenovacia stránka (`scan.html` + `scan.css`) má aladinský dizajn podľa
dodaného SVG mocku. Admin, nastavenia a QR stránka ostávajú zámerne
minimalistické na `style.css`.

Podklady v `public/design/` sú vyrezané z mocku (SVG malo 27 MB, čo by na
táborovej WiFi nebolo použiteľné) — spolu **117 kB**:

| súbor | čo to je | ako vzniklo |
|---|---|---|
| `bg.jpg` | gradient + dym, 1080×1920 | vrstvy pozadia z mocku vyrenderované do JPEG |
| `lamp.png` | lampa vľavo dole | vrstva orezaná na alfa bounding box |
| `logo.png` | HeyPay logo vpravo hore | vrstva orezaná na alfa bounding box |

Farby z mocku: fialová `#84309c`, zlatá `#fbcf35`, gradient
`#fdd82d → #e67b6e → #c14b8f → #7d2e9b` (v CSS aj ako záloha, keby sa
`bg.jpg` nenačítal). Písmo je systémové (Avenir Next / Helvetica Neue /
Roboto) v ťažkom reze — na tábore nie je internet, takže žiadne webfonty.

Dve vedomé odchýlky od mocku:

- **Výsledok skenu** (ostáva / ide do skupinky X) je plná sýta zelená a
  červená, nie priesvitné sklo — animátor to musí prečítať na priamom slnku
  na jeden pohľad. Čitateľnosť tu má prednosť pred vzhľadom.
- Tlačidlá **START / STOP SCANNING** z mocku sú napojené na reálne zapnutie
  a vypnutie kamery (šetrí batériu pri presune medzi stanovišťami).

## Zvuky pri skenovaní

Skener prehrá po každom skene zvuk z `public/sounds/`:

| súbor | kedy hrá |
|---|---|
| `patri.mp3` („duuuuuh“) | dieťa patrí do skupinky — zelený výsledok |
| `nepatri.mp3` („e-eeeeh“) | dieťa ide do inej skupinky — červený výsledok |

Pri **bait** deťoch (nepatria, ale zámerne ešte ostávajú) hrá zvuk „patrí“ —
rovnako ako svieti zelená. Deti zvuk počujú, a keby zaznelo „e-eeeeh“ a dieťa
aj tak ostalo, hneď by im bolo jasné, že appka zdržiava.

Poznámky:

- Zvuk je doplnok — keď súbory chýbajú alebo prehliadač prehratie odmietne,
  skenovanie beží ďalej (ostáva farebný výsledok a vibrácia).
- Mobilné prehliadače pustia zvuk až po prvom ťuknutí na stránku; appka ich
  preto odomkne pri tlačidle „Potvrdiť a skenovať“.
- **Telefón nesmie byť na tichom režime** — iOS stlmí zvuk stránky prepínačom
  na boku telefónu.

## Priebeh hry (workflow)

1. **Settings**: naimportuj deti (meno + home_group; náramok a QR sa dogenerujú).
2. **QR stránka**: vytlač kódy na náramky.
3. **Admin**: „Rozdeliť podľa náramkov“ (súvislé bloky čísel — podľa manuálu) → „Spustiť hru“.
4. **Animátori** na mobiloch otvoria `/scan.html`, vyberú svoje stanovište
   (appka im povie, ktorá skupina tam podľa kola je), skenujú deti.
5. Po odskenovaní všetkých stlačia **„Ukončiť kolo pre túto skupinu“** — skupina
   sa v appke posunie na ďalšie stanovište. Keď kolo ukončia všetky skupiny,
   kolo sa posunie automaticky (admin ho vie aj vynútiť).
6. Hra končí po `max_rounds` (default 10) alebo tlačidlom „Ukončiť hru“ —
   funguje aj pri predčasnom konci, stav je vždy konzistentný.

## Herná logika (lib/game.js)

- **Zhoda** `home_group == aktuálna skupina` → dieťa ostáva, counter sa nuluje (zelená).
- **Nezhoda** → `rounds_in_wrong_group++`; kým je counter **pod prahom**
  (`bait_delay`), dieťa ostáva ako „bait“ (animátorovi sa ukáže zelená, deti nič
  netušia); po **dosiahnutí prahu** presun do nasledujúcej skupiny (+1, wrap
  10→1, červená) a counter sa nuluje.
- Prah: fixný (`settings.bait.delay_rounds`) alebo náhodný per-dieťa
  z intervalu pri každom novom nesprávnom zaradení (`mode: "random"`).
  **Pozn. k sémantike:** prah 0 a 1 znamenajú „presun hneď pri prvom
  nesúhlasnom skene“, prah 2 = dieťa ostane 1 kolo navyše. Presné pravidlo sa
  ladí na jednom mieste: `computeBaitDelay()` v `lib/game.js`.
- **Porotovanie na štarte `min_start_distance`** (default 2, 0 = vypnuté):
  pri rozdelení detí do skupín dostane každé dieťa skupinu vzdialenú aspoň
  takto veľa od jeho domovskej (v smere rotácie +1). Pri hodnote 2 nie je
  žiadne dieťa vo svojej domovskej skupinke počas 1. ani 2. kola — každé sa
  musí najprv porotovať.
- **Rovnaké počty detí v skupinách počas celej hry.** Keďže dieťa sa posúva
  vždy len o +1 skupinu, veľkosť skupiny sa nemení práve vtedy, keď z nej
  odíde toľko detí, koľko do nej príde z predchádzajúcej. Rozdelenie to
  zaručuje tak, že **každá domovská skupina dostane rovnaký profil
  počiatočných vzdialeností** (rovnako veľa jej detí štartuje 2 skupiny od
  domova, rovnako veľa 3 atď.) — vzdialenosti sa prideľujú cyklicky v rámci
  domovskej skupiny, nie náhodne na skupiny. Náhodný je len posun cyklu
  (každá hra vyzerá inak) a poradie detí. Dva limity, ktoré to rozbíjajú:
  - veľkosti skupín kopírujú **veľkosti domovských skupín** — pri 105 deťoch
    (5× 11 + 5× 10) budú skupiny 10–11 aj počas hry; úplne rovnaký počet
    vyžaduje rovnako veľké domovské skupiny (napr. 100 detí = 10× 10).
    Nevyvážené domovské skupiny appka hlási v Nastaveniach;
  - **náhodný bait režim** deti rozsynchronizuje a počty rozhádže
    (5–15 v skupine). Fixný prah (1 aj 2) drží počty konštantné.
- **Logistická poistka `force_home_round`** (default 8, 0 = vypnuté): od tohto
  kola sa bait aj posun +1 ignorujú a nesúhlasiace dieťa ide pri skene ROVNO
  do svojej domovskej skupinky (skener ukáže „🏠 IDE DOMOV — SKUPINKA X“).
  Garantuje správne rozdelenie na konci hry bez ohľadu na bait nastavenie.
- **Korekcia reality**: ak sa naskenuje dieťa v skupine, kde ho appka
  neevidovala (utieklo, chyba), appka uverí realite — preradí ho do skenujúcej
  skupiny (log `correction`) a až potom aplikuje pravidlá.
- **Duplicitný sken** v tom istom kole sa nezapočíta dvakrát, animátor dostane
  upozornenie.
- **Edge case „nestihne domov“**: posun je len +1 skupina/kolo, takže dieťa
  ďaleko od domova to pri vyššom prahu nemusí stihnúť. Admin tabuľka:
  🟠 = matematicky to už nestihne, 🔴 = koniec hry a stále mimo domova.
  (Overené simuláciou: prah 1 → všetci doma za 10 kôl; prah 2 → ~40/105 detí
  skončí mimo — viď `npm test`.)

## Dáta (data/*.json)

Čitateľný JSON, dá sa ručne upraviť (server needituj počas zápisu, inak stačí
reload stránky). Štruktúra je pripravená na neskoršiu migráciu do SQLite
(children → tabuľka, state.scans → tabuľka skenov).

- `children.json` — deti: `id`, `name`, `wristband_number`, `qr_code`,
  `home_group`, `current_group`, `rounds_in_wrong_group`, `bait_delay`,
  `history` (log presunov: kolo, z→do, stanovište, timestamp).
- `settings.json` — počty, stanovištia (poradie poľa = poradie rotácie),
  `group_start_station`, bait konfigurácia.
- `state.json` — status, `current_round`, skupiny (stanovište + ukončené kolo),
  `scans` (log všetkých skenov).

## Excel import (neskôr)

Všetky deti vchádzajú do systému cez `importChildren(rows)` v `lib/game.js`
(`POST /api/children/import`, `{rows: [{name, home_group, wristband_number?, qr_code?}]}`).
Na Excel stačí rozparsovať xlsx na tieto riadky a zavolať tú istú funkciu.
Zatiaľ funguje CSV textarea v Settings (`meno;home_group[;náramok[;qr]]`).

## Testy

```bash
npm test
```

Simuluje celú hru (105 detí, 10 kôl) vrátane bait prahu, korekcií a edge caseov.

## Rozhodnutia pri nejasnostiach (na skontrolovanie)

- **Počiatočné rozdelenie**: „Podľa náramkov“ / „Náhodne“ určuje len poradie,
  v akom deti dostávajú vzdialenosť od domova — samotné rozdelenie sa riadi
  profilom vzdialeností (viď vyššie), aby počty v skupinách ostali rovnaké.
  Súvislé bloky podľa manuálu (1–11 → sk. 1, …) vzniknú pri
  `min_start_distance` = 0 len vtedy, keď sú domovské skupiny v poradí
  náramkov rovnomerne rozhádzané.
- **Počiatočné mapovanie**: skupina 1 → A, 2 → B, … 10 → J; editovateľné v Settings.
- **Kapacita staníc sa nerieši** — skupina je proste množina detí, stanica ju
  zvládne v ľubovoľnej veľkosti (manuál kapacity nešpecifikuje).
- **„Ukončiť kolo“ je per skupina** — každá skupina sa posúva vlastným tempom,
  globálne kolo sa zvýši, keď skončia všetky (alebo to admin vynúti). Toto
  zodpovedá realite, že skupiny nekončia icebreakre naraz.
- **Bait sa počíta per sken** (1 sken = 1 kolo v skupine), nie per uplynulé
  kolo — ak dieťa v niektorom kole nenaskenujú, kolo sa mu do zdržania neráta.
