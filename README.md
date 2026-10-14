# telly for Mac and Windows

A small, fast IPTV player for your computer: the desktop sibling of
[telly for Fire TV and Android TV](https://github.com/tellyteam/telly). Bring your own provider
(Xtream Codes or an M3U playlist); telly gives you a clean way to watch it.

- **Home** with Pick up where you left off, Continue watching, My List and recently added titles
- **Live TV** with categories, a live preview and the programme guide (now and next)
- **Series and films** in rows, detail pages, seasons and episodes, and full-window grids
- **Picks up where you left off**, including the next episode once the credits roll
- **Search everything** from anywhere with <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd>
- **My List** for films, series and channels
- **Aspect ratio** per channel or title, including a custom size
- **Keyboard first**: <kbd>Space</kbd> pause, <kbd>←</kbd> <kbd>→</kbd> 10 seconds, <kbd>F</kbd> full screen,
  <kbd>N</kbd> next episode, <kbd>P</kbd> picture in picture, <kbd>Esc</kbd> back
- About 10 MB, using the system's own web engine rather than a bundled browser

telly contains no channels or content. You need your own subscription from an IPTV provider.

## Install

Download the latest version from [Releases](https://github.com/tellyteam/telly-desktop/releases/latest).

- **Mac** (Apple silicon and Intel, macOS 11+): open the `.dmg` and drag telly to Applications.
  telly isn't signed by Apple yet, so the first time, **right-click telly → Open → Open**.
- **Windows 10 and 11**: run `telly_…_x64-setup.exe`. If SmartScreen appears, choose
  **More info → Run anyway**. No administrator rights are needed.

**Updating:** telly checks GitHub once a week and shows an update in **Settings → Updates** (you can
check there any time). Download it and install over the top; everything you've set up is kept.

## Privacy

- telly talks only to your provider, plus a weekly check with GitHub for a new version.
  No accounts, analytics, adverts or tracking.
- Your provider login is kept in the **macOS Keychain** or **Windows Credential Manager**.
  History, progress, My List and settings are encrypted on disk with a key kept there too.
- Plain HTTP is refused unless you allow it for your provider (some providers have no HTTPS).

## How it works

A web page can't play IPTV: providers don't send the headers browsers need, and most streams are
plain `http://`. So telly is a [Tauri](https://tauri.app) app. The interface is Svelte and
TypeScript in the system web view (WebKit on Mac, WebView2 on Windows), and a small Rust core runs a
**local relay** on `127.0.0.1` that fetches everything from the provider on the interface's behalf.
Playback uses the Mac's native HLS (which also decodes Dolby audio), [hls.js](https://github.com/video-dev/hls.js)
and [mpegts.js](https://github.com/xqq/mpegts.js). For the odd stream the web engine can't decode
(some MKV files), telly offers **Open in VLC** when VLC is installed.

| Path | What's there |
|---|---|
| `src/lib/` | Provider parsing (Xtream, M3U, guide), catalogue cache, playback rules, state |
| `src/screens/`, `src/components/` | The interface |
| `src-tauri/src/relay.rs` | The local stream relay (HLS playlists are rewritten to come through it too) |
| `src-tauri/src/secure.rs` | Keychain / Credential Manager and encrypted storage |
| `dev/` | `npm run dev` helpers: a browser stand-in for the relay and a fake provider |

## Building from source

Requires Node 22+ and Rust (stable). On Windows, also the
[Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
npm install
npm test                 # unit tests (TypeScript)
(cd src-tauri && cargo test)   # unit tests (Rust)
npx tauri dev            # run the app
npx tauri build          # build the installer for this computer
```

`npm run dev` also runs the interface in an ordinary browser at http://localhost:5173, with a
stand-in relay. To try it without a real provider, use the built-in fake one: server
`http://localhost:5173/__dev/fake`, any username and password, and allow plain HTTP. A git-ignored
`provider.local.properties` (`server`, `username`, `password`, or `type=m3u` with `url`) pre-fills the
setup screen in development only.

## Releasing

Push a version tag; GitHub Actions tests, builds the Mac (universal) and Windows apps and publishes
them as a release:

```bash
git tag v1.0.1 && git push origin v1.0.1
```

## Licence

telly is free software, licensed under the [GNU General Public License v3.0](LICENSE).
