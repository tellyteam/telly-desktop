# telly for LG TVs

A small, fast IPTV player for LG smart TVs (webOS 6 and later), driven entirely by the remote.
Bring your own provider (Xtream Codes or an M3U playlist); telly gives you a clean way to watch it.

- **Home** with Pick up where you left off, Continue watching, My List and recently added titles
- **Live TV** with categories, a live preview and the programme guide (now and next); CH+ and CH−
  change channel while you watch
- **Series and films** in rows, detail pages, seasons and episodes
- **Picks up where you left off**, including the next episode once the credits roll
- **My List** for films, series and channels
- **Aspect ratio** per channel or title, including a custom size
- Plays with the TV's own media player and hardware decoding (HLS, MPEG-TS, MKV, MP4)

telly contains no channels or content. You need your own subscription from an IPTV provider.

telly is also on [Android TV and Fire TV](https://github.com/tellyteam/telly-android) and
[iPad and Mac](https://github.com/tellyteam/telly-apple).

## Install

telly isn't in LG's Content Store, so it's installed from a computer with the TV in Developer Mode.

1. On the TV, install **Developer Mode** from the LG Content Store and sign in with a (free)
   [LG developer account](https://webostv.developer.lge.com). Turn on **Dev Mode Status** (the TV
   restarts), then **Key Server**. Note the TV's IP address and the passphrase it shows.
2. On your computer (with [Node](https://nodejs.org)), install LG's tools and add the TV:
   ```bash
   npm install -g @webos-tools/cli
   ares-setup-device --add tv --info "{'host':'TV_IP_ADDRESS','port':'9922','username':'prisoner'}"
   ares-novacom --device tv --getkey       # asks for the passphrase the TV shows
   ```
3. Download the latest `.ipk` from [Releases](https://github.com/tellyteam/telly-lg/releases/latest) and install it:
   ```bash
   ares-install --device tv io.github.tellyteam.telly_*.ipk
   ```

telly then appears with your other apps. Developer Mode lasts 50 hours at a time: open the
Developer Mode app and choose **Extend** now and then, or apps installed this way stop opening.
To update, install the new `.ipk` the same way; everything you've set up is kept.

## Privacy

- telly talks only to your provider. No accounts, analytics, adverts or tracking.
- Your provider login, history, progress and My List stay on the TV, in telly's own storage.
- Plain HTTP is refused unless you allow it for your provider (some providers have no HTTPS).

## How it works

The interface is Svelte and TypeScript, built as one classic script for the TV's web engine
(Chromium 79 on webOS 6). A packaged webOS app may fetch from any address, so the TV talks to the
provider directly. Playback uses the TV's own player whenever it says it can play a stream, and
[hls.js](https://github.com/video-dev/hls.js) or [mpegts.js](https://github.com/xqq/mpegts.js)
otherwise. The remote moves focus spatially (`src/lib/tv.ts`).

| Path | What's there |
|---|---|
| `src/lib/` | Provider parsing (Xtream, M3U, guide), catalogue cache, playback rules, state, remote control |
| `src/screens/`, `src/components/` | The interface |
| `webos/` | The app's `appinfo.json`, icons and splash (drawn by [telly-brand](https://github.com/tellyteam/telly-brand)) |
| `scripts/webos-pack.mjs` | Packs the build into an `.ipk` |
| `dev/` | `npm run dev` helpers: a relay for the browser and a fake provider |

## Building from source

Requires Node 22+.

```bash
npm install
npm test           # unit tests
npm run build      # build-webos/io.github.tellyteam.telly_<version>_all.ipk
```

LG's [webOS TV Simulator](https://webostv.developer.lge.com/develop/tools/simulator-introduction)
runs the build without a TV: `npx ares-launch -s 26 -sp <path to the Simulator> dist-webos`.

`npm run dev` runs the interface in an ordinary browser at http://localhost:5173, with a relay
standing in for the TV's direct access. To try it without a real provider, use the built-in fake
one: server `http://localhost:5173/__dev/fake`, any username and password, and allow plain HTTP.
A git-ignored `provider.local.properties` (`server`, `username`, `password`, or `type=m3u` with
`url`) pre-fills the setup screen in development only.

## Releasing

Push a version tag. GitHub Actions tests, builds the `.ipk` and attaches it to a draft release;
write the notes, then publish it.

```bash
git tag v1.0.0 && git push origin v1.0.0
```

## Licence

telly is free for personal, non-commercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE). Commercial use, including selling telly or bundling it with a paid service, needs permission: ask through GitHub.
