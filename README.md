# Boring API

Eine API aus Dateien: Ordner bilden URL-Pfade, `get.ts` und `post.ts` bilden HTTP-Methoden. Dateien mit `+` steuern gemeinsame Aufgaben. Boring API verbindet sie beim Start automatisch, ohne Router-Verschachtelung oder Decorators.

```text
api/
├── +setup.ts                  Dienste einmalig starten
├── +auth.ts                   Authentifizierung und Autorisierung
├── +middleware.ts             Middleware für alle Routen
├── +envelope.ts               Antwortformat für alle Routen
├── +error.404.ts              Fehlerdarstellung für HTTP 404
└── items/
    ├── +middleware.ts         zusätzliche Middleware nur für /items/*
    ├── latest/get.ts          GET /items/latest
    └── [id]/get.ts            GET /items/:id
```

Das API-Verzeichnis gehört der Anwendung. Es kann beliebig heißen; die Anwendung übergibt seinen Pfad an Boring API. `src` enthält nur die Bibliothek. Ein ausführbares, getrenntes Beispiel liegt unter `examples/basic`.

## Installation

`@boringapi/core` ist das veröffentlichte Node-Modul. Es installiert den ausführbaren Befehl `boring` über das `bin`-Feld des Pakets:

```bash
npm install @boringapi/core zod
# oder: pnpm add @boringapi/core zod
# oder: yarn add @boringapi/core zod
```

Nach der lokalen Installation ist der Befehl in den Package-Scripts der Anwendung verfügbar. Er kann außerdem mit `npx boring`, `pnpm exec boring` oder `yarn boring` direkt ausgeführt werden.

## CLI

Die drei normalen Befehle übernehmen Laden, Typgenerierung und Prüfung:

```bash
boring dev                 # ./api laden, Typen erzeugen, bei Änderungen neu starten
boring check               # Typen erzeugen und das Projekt mit TypeScript prüfen
boring start               # kompilierte API ohne Watcher starten
```

Das API-Verzeichnis ist standardmäßig `./api`. Ein anderer Pfad kann als Argument oder mit `--dir` angegeben werden. Der Port ist standardmäßig 4040.

```bash
boring dev src/api --port 3000
boring check src/api
boring start dist/api --port 3000
```

`boring dev` lädt TypeScript über `ts-node`, generiert Typen vor jedem Neustart und beobachtet das API-Verzeichnis. `boring check` prüft TypeScript, die Dateikonventionen und die Exportverträge aller Routen und Hooks. `boring start` ist für kompiliertes JavaScript gedacht. `boring sync` erzeugt nur die Typdateien.

Diese Scripts gehören in die `package.json` der Anwendung, die Boring API verwendet:

```json
{
  "scripts": {
    "dev": "boring dev",
    "check": "boring check",
    "start": "boring start dist/api"
  }
}
```

### Einbindung in einen vorhandenen Server

```ts
// server.ts in der Anwendung des Nutzers
import { join } from "path";
import { BoringApi } from "@boringapi/core";

async function main() {
    const app = await new BoringApi().createApp(join(__dirname, "api"));
    app.listen(4040);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
```

`createApp(directory)` liefert eine Express-App. `listen(directory, port)` startet direkt einen HTTP-Server und gibt ihn zurück. `scan(directory, port)` bleibt als älterer Alias erhalten. Der Loader scannt das angegebene Verzeichnis beim Start und verlangt ladbare `.ts`- oder `.js`-Dateien.

## Eine Route hinzufügen

Die Namen `get.ts`, `post.ts`, `put.ts`, `patch.ts`, `delete.ts`, `head.ts` und `options.ts` sind reserviert. Ein `get.ts` direkt in `api/` bedient `GET /`. Ein Ordner `[id]` wird zum URL-Parameter `:id`. Statische Routen gewinnen gegen dynamische. Doppelte oder unbekannte Konventionsdateien brechen den Start ab.

```ts
// api/articles/[id]/get.ts
import z from "zod";
import { HttpError } from "@boringapi/core";
import type { GetHandler } from "./$types";

type ArticleStore = {
    find(id: string): Promise<{ id: string; title: string } | undefined>;
};

export const params = z.object({ id: z.string().min(1) });
export const output = z.object({ id: z.string(), title: z.string() });
export const authentication = true;

export const handler: GetHandler = async ctx => {
    const store = ctx.services.articles;
    const { id } = ctx.params;
    const article = await store.find(id);
    if (!article) throw new HttpError(404, "Article not found");
    return article;
};
```

`ArticleStore` bezeichnet hier den Typ eines anwendungseigenen Dienstes. Er wird in `+setup.ts` registriert. Für eine direkt kopierbare Demo siehe `examples/basic/api`.

| Export einer Methodendatei | Wirkung |
| --- | --- |
| `handler: GetHandler` | Pflicht; typisiert Kontext und Rückgabe anhand dieser Datei. Für andere Methoden entsprechend `PostHandler`, `PatchHandler` usw. |
| `params`, `query`, `body` | Optionale Zod-Schemas für URL-Parameter, Query-Parameter und JSON-Body. |
| `output` | Optionales Zod-Schema für die Antwort vor dem Envelope. |
| `authentication = true` | Verlangt eine Session aus `+auth.ts`; ohne Session HTTP 401. |
| `authorization = rule` | Verlangt eine Session und übergibt `rule` an `authorize()` in `+auth.ts`. |
| `envelope = false` | Überspringt den geerbten Envelope für diese Route. |

Ungültige Eingaben liefern HTTP 400, ungültige Ausgaben HTTP 500. Ein Handler ohne Rückgabewert und ohne `ctx.payload` liefert HTTP 204. `ctx.payload = value` ist eine Alternative zum Rückgabewert. `ctx.status(201)` setzt den Erfolgsstatus. `ctx.send(value)` sendet sofort und umgeht damit `output` und Envelope.

## Generierte Typen

`boring dev`, `boring check` und `boring sync` erzeugen für jeden Routenordner ein virtuelles `$types`-Modul unter `.boring/types`. Der Generator liest keinen Anwendungscode aus und dupliziert keine Schemas. Die erzeugten Typen referenzieren die Exporte der jeweiligen Methodendatei:

- `params`, `query` und `body` werden nach ihrer Zod-Ausgabe typisiert.
- Die Rückgabe von `GetHandler` oder `PostHandler` muss zur Eingabe des `output`-Schemas passen.
- Der Rückgabewert von `+setup.ts` wird zu `ctx.services`.
- Der Rückgabewert von `authenticate()` wird zu `ctx.session`. Bei geschützten Routen ist `session` nicht optional.
- Der Typ des zweiten `authorize()`-Parameters begrenzt erlaubte Werte für den `authorization`-Export.
- Die Rückgabewerte aller geerbten `+middleware.ts`-Dateien werden zu `ctx.locals` zusammengeführt.

Die Dateien werden nicht eingecheckt. Damit der Editor `./$types` genauso wie `boring check` auflösen kann, gibt es zwei Möglichkeiten. Ein einfaches Projekt lässt seine `tsconfig.json` die generierte Konfiguration erweitern:

```json
{
  "extends": "./.boring/tsconfig.json",
  "compilerOptions": {
    "strict": true
  }
}
```

Falls die Anwendung bereits eine andere Basiskonfiguration erweitert, wird stattdessen nur `rootDirs` ergänzt:

```json
{
  "compilerOptions": {
    "rootDirs": [".", ".boring/types"]
  }
}
```

Die Konfiguration entsteht beim ersten `boring sync`, `boring dev` oder `boring check`. `boring check` setzt `rootDirs` selbst und funktioniert daher auch ohne diese Editor-Einstellung.
Das API-Verzeichnis muss innerhalb des Projekts liegen, weil seine Position auf das generierte Verzeichnis `.boring/types` abgebildet wird.

## Dateien mit `+`

Die Dateinamen sind der Vertrag des Frameworks. Für gemeinsame Logik werden keine Express-Router per Hand verschachtelt.

| Datei | Ort und Lebensdauer | Vertrag |
| --- | --- | --- |
| `+setup.ts` | Nur an der API-Wurzel; einmal pro `createApp()` | `setup(ctx)` gibt ein Objekt mit langlebigen Diensten zurück. Es steht typisiert als `ctx.services` bereit. Manuelles `ctx.set()` bleibt möglich, kann aber nicht abgeleitet werden. |
| `+auth.ts` | Nur an der API-Wurzel; bei jeder gefundenen Route | `authenticate(ctx)` gibt eine Session zurück. `authorize(ctx, rule)` prüft eine Routenregel. Beide Exporte sind optional, mindestens einer ist nötig. |
| `+middleware.ts` | In jedem URL-Ordner; pro Request von der Wurzel zum Routenordner | `handler(ctx)` gibt neue Request-Locals zurück. Sie stehen in nachfolgenden Schritten typisiert unter `ctx.locals`. Eine frühe Antwort per `ctx.send()` ist möglich. |
| `+envelope.ts` | In jedem URL-Ordner; pro erfolgreicher Antwort | `handler(ctx)` gibt die formatierte Antwort zurück oder setzt `ctx.payload`. Die nächstgelegene Datei gilt. |
| `+error.ts`, `+error.404.ts`, `+error.500.ts` | In jedem URL-Ordner; beim Fehler | `handler(ctx, error)` gibt die Fehlerantwort zurück. Die nächstgelegene Vorlage gilt; eine passende Statusdatei hat im selben Ordner Vorrang. |

Middleware **stapelt sich** entlang des URL-Pfades. Envelope und Fehlerdarstellung **überschreiben** dagegen die geerbte Vorlage, statt mehrfach ineinander verpackt zu werden. Für einen nicht gefundenen Pfad gilt die Fehlerdarstellung an der API-Wurzel. Leere HTTP-204-Antworten erhalten keinen Envelope.

Im frühen Prototyp lagen diese Aufgaben in `_base/` und `_setup/`. Diese Sammelordner werden durch eindeutige `+`-Dateien ersetzt: `_setup/*` wird zu `+setup.ts`, Authentifizierung und Autorisierung aus `_base/` werden zu `+auth.ts`, die Envelope-Datei zu `+envelope.ts` und `404.ts` zu `+error.404.ts`. Die alten Ordner lösen beim Start einen Hinweis auf die neuen Konventionen aus.

Ohne Konventionsdateien gelten sichere Standards: keine Session, HTTP 401 für geschützte Routen ohne Session, HTTP 403 bei einer Autorisierungsregel ohne `authorize()`, unveränderte Erfolgsantwort und JSON-Fehlerantwort ohne interne Serverdetails. Ein Standard-Logger ist vorhanden. `+auth.ts` und `+setup.ts` ersetzen beziehungsweise ergänzen dieses Verhalten nach Bedarf. Das Beispiel unter `examples/basic/api/+auth.ts` nutzt ein Umgebungstoken nur zur Demonstration.

## Kontext und Ablauf

Jede Anfrage erhält einen eigenen `Context`. `ctx.request` und `ctx.response` sind die Express-Objekte. `ctx.params`, `ctx.query` und `ctx.body` enthalten die validierten Eingaben. `ctx.services`, `ctx.session` und `ctx.locals` werden aus den Konventionsdateien abgeleitet. Die Map-Methoden `get()` und `set()` bleiben für dynamische Sonderfälle vorhanden; Rückgabewerte sind der typisierte Standardweg. Request-Daten gehören nicht in globale Variablen oder in den Setup-Kontext.

Pro Route läuft: Authentifizierung → geerbte Middleware → Session-Prüfung → Autorisierung → Eingabevalidierung → Handler → Ausgabevalidierung → nächstgelegener Envelope → Senden. Alle Schritte werden abgewartet. Beim Fehler erhält die passende Fehlerdatei denselben Request-Kontext.

## Lokales Beispiel und Prüfungen

Dieser Abschnitt betrifft ausschließlich die Arbeit am Repository von `boring-api`. Die Scripts werden nicht in Anwendungen übernommen; dort kommt der oben beschriebene `boring`-Befehl aus dem installierten Paket zum Einsatz. Voraussetzung ist Node.js 18 oder neuer. Das Repository enthält eine `yarn.lock`.

```bash
yarn install
yarn example:dev     # führt den lokalen Quellcode gegen examples/basic/api aus
yarn example:check   # prüft das lokale Beispiel
yarn example:sync    # erzeugt nur die Typen des lokalen Beispiels
yarn example:start   # startet examples/basic/server.ts
yarn typecheck
yarn test
yarn build      # kompiliert nur die Bibliothek nach dist
```

## Veröffentlichung

Ein Tag `v<version>` startet den Release-Workflow. Der Tag muss exakt zur Version in `package.json` passen, beispielsweise `v0.0.1` zu `"version": "0.0.1"`. Vor der Veröffentlichung laufen Beispielprüfung, TypeScript-Prüfung, Tests und Build. Anschließend erzeugt der Workflow ein npm-Tarball, veröffentlicht es über npm Trusted Publishing und erstellt ein GitHub Release mit Prüfsumme und automatisch erzeugten Release Notes.

Der Trusted Publisher für `@boringapi/core` verwendet diese GitHub-Actions-Daten:

- Organisation oder Benutzer: `PaDreyer`
- Repository: `boring-api`
- Workflow-Datei: `release.yml`
- Erlaubte Aktion: `npm publish`

Da ein Trusted Publisher erst für ein bereits existierendes npm-Paket eingerichtet werden kann, wird die erste Version einmalig interaktiv mit `npm publish --access public` veröffentlicht. Danach wird der Trusted Publisher in den Paketeinstellungen aktiviert; weitere Versionen entstehen ausschließlich durch passende Git-Tags.

Für einen normalen Patch-Release erhöht `npm version patch` die Version in `package.json`, erstellt einen Release-Commit und legt den passenden Git-Tag an. Der anschließende Push überträgt Branch und Tag und startet dadurch den Release-Workflow:

```bash
npm version patch
git push origin master --follow-tags
```

Für Minor- oder Major-Releases wird entsprechend `npm version minor` beziehungsweise `npm version major` verwendet.

Der Beispielserver hört standardmäßig auf Port 4040; `PORT` kann ihn ändern.

```bash
curl http://localhost:4040/health
curl http://localhost:4040/items/42
curl -X POST http://localhost:4040/echo \
  -H 'Content-Type: application/json' \
  -d '{"message":"Hallo"}'
```

Die Antworten sind `{"service":"boring-api","status":"ok"}`, `{"id":"42"}` und `{"data":{"message":"Hallo"}}`. Der aktuelle Umfang unterstützt JSON-Bodies und einzelne dynamische Segmente wie `[id]`. Catch-all-Segmente sind noch nicht definiert.
