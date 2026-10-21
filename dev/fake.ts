import type { ServerResponse } from "node:http";

/**
 * A pretend Xtream provider for `npm run dev`, so the UI can be exercised without a real login.
 * Server address: http://localhost:5173/__dev/fake (any username and password; allow plain HTTP).
 * Streams redirect to public test videos.
 */

const HLS = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
const MP4 = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_5MB.mp4";
const words = ["Harbour", "Signal", "Copper", "Valley", "Night", "Train", "Paper", "Moons", "Long", "Field", "Glass", "Winter", "Lines", "Small", "Hours",
  "Kingfisher", "Rain", "North", "Road", "Static", "Blue", "Daybreak", "Hollow", "Hill", "Marlow", "River", "Outpost", "Tide", "Bright", "Water"];
const pick = (i: number, n: number) => words[(i * 7 + n * 13) % words.length];
const title = (i: number) => (i % 3 ? `${pick(i, 1)} ${pick(i, 2)}` : `The ${pick(i, 3)}`) + (i > 30 ? ` ${Math.floor(i / 30) + 1}` : "");

const liveCats = ["UK · Entertainment", "UK · News", "UK · Sport", "UK · Movies", "UK · Kids", "Documentaries", "Music", "USA · Entertainment"];
const filmCats = ["New this month", "Action", "Comedy", "Drama", "Documentaries", "Family", "Horror", "Sci-fi"];
const seriesCats = ["Drama", "Crime", "Comedy", "Reality", "Documentaries", "Kids"];
const chanNames = ["News 24", "World News", "Sport One", "Sport Two", "Arena", "Drama+", "Comedy Gold", "Movies 1", "Movies 2", "Docs", "Nature", "History", "Kids", "Toons", "Music Hits", "Weather", "Business", "Food", "Travel", "Retro"];
const shows = ["The Six O'Clock News", "Live: Evening Match", "Coast to Coast", "The Bake Off", "Planet Deep", "The Quiz", "Late Film: Signal", "Breakfast"];

const now = () => Math.floor(Date.now() / 1000);
const b64 = (s: string) => Buffer.from(s).toString("base64");

function poster(seed: string, w: number, h: number) {
  const hue = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  const text = seed.replace(/[<&>]/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 50% 55%)"/><stop offset=".6" stop-color="hsl(${(hue + 35) % 360} 50% 30%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 45% 14%)"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/><text x="${w * 0.08}" y="${h * 0.86}" font-family="Helvetica, Arial" font-weight="800" font-size="${Math.round(w / 9)}" fill="#fff">${text}</text></svg>`;
}

export function fakeProvider(path: string, query: URLSearchParams, res: ServerResponse, base: string) {
  const json = (v: unknown) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(v));
  const img = (kind: string, seed: string) => `${base}/img/${kind}/${encodeURIComponent(seed)}.svg`;

  const m = path.match(/^\/img\/(\w+)\/(.+)\.svg$/);
  if (m) {
    const seed = decodeURIComponent(m[2]);
    const [w, h] = m[1] === "poster" ? [300, 450] : m[1] === "logo" ? [200, 120] : [960, 540];
    const svg = m[1] === "logo"
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><text x="100" y="72" text-anchor="middle" font-family="Helvetica" font-weight="900" font-size="30" fill="#1b2433">${seed.toUpperCase().slice(0, 9)}</text></svg>`
      : poster(seed, w, h);
    return res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=3600" }).end(svg);
  }
  if (/^\/live\//.test(path)) return res.writeHead(302, { Location: HLS }).end();
  if (/^\/(movie|series)\//.test(path)) return res.writeHead(302, { Location: path.endsWith(".m3u8") ? HLS : MP4 }).end();
  if (!path.endsWith("player_api.php")) return res.writeHead(404).end();

  const action = query.get("action");
  if (!action) return json({ user_info: { auth: 1, status: "Active", allowed_output_formats: ["m3u8", "ts"] } });
  const cats = (list: string[]) => json(list.map((name, i) => ({ category_id: String(i + 1), category_name: name })));
  switch (action) {
    case "get_live_categories": return cats(liveCats);
    case "get_vod_categories": return cats(filmCats);
    case "get_series_categories": return cats(seriesCats);
    case "get_live_streams":
      return json(Array.from({ length: 160 }, (_, i) => {
        const name = `${chanNames[i % chanNames.length]}${i >= chanNames.length ? ` ${Math.floor(i / chanNames.length) + 1}` : ""}`;
        return { stream_id: 1000 + i, name, stream_icon: img("logo", name.split(" ")[0]), epg_channel_id: `c${i}`, category_id: String((i % liveCats.length) + 1) };
      }));
    case "get_vod_streams":
      return json(Array.from({ length: 420 }, (_, i) => ({
        stream_id: 5000 + i, name: title(i), stream_icon: i % 9 === 4 ? "" : img("poster", title(i)), category_id: String((i % filmCats.length) + 1),
        container_extension: "mp4", added: String(now() - i * 3600 * 7),
      })));
    case "get_series":
      return json(Array.from({ length: 140 }, (_, i) => ({
        series_id: 800 + i, name: title(i + 50), cover: img("poster", title(i + 50)), plot: `On a remote island where everyone knows everyone, a returning detective uncovers what ${title(i + 50)} has kept hidden for thirty years.`,
        category_id: String((i % seriesCats.length) + 1), last_modified: String(now() - i * 3600 * 11),
      })));
    case "get_series_info": {
      const id = Number(query.get("series_id"));
      const name = title(id - 800 + 50);
      const episodes: Record<string, unknown[]> = {};
      for (let s = 1; s <= 1 + (id % 6); s++) {
        episodes[String(s)] = Array.from({ length: 6 + (id % 4) }, (_, e) => ({
          id: String(id * 1000 + s * 100 + e + 1), episode_num: e + 1, title: `${name} - S0${s}E0${e + 1} - ${pick(e + s, 4)} ${pick(e, 5)}`,
          container_extension: e % 2 ? "m3u8" : "mp4", season: s,
          info: { movie_image: img("still", `${name} ${s}.${e + 1}`), plot: `Episode ${e + 1}: things at ${pick(e, 6)} ${pick(e, 7)} take a turn.`, duration_secs: 596 },
        }));
      }
      return json({ info: { plot: `On a remote island where everyone knows everyone, a returning detective uncovers what ${name} has kept hidden for thirty years.`,
        genre: "Crime / Drama", releaseDate: "2024-02-01", rating: "8.1", backdrop_path: [img("backdrop", name)], cast: "Ellen Price, Tom Hale, Ruth Marsh" }, episodes });
    }
    case "get_vod_info":
      return json({ info: { plot: "A quiet town, a missing letter and a storm that won't break.", genre: "Thriller", releasedate: "2023-10-12", rating: "7.4",
        duration: "01:52:00", backdrop_path: [img("backdrop", `film ${query.get("vod_id")}`)], cast: "Ana Ruiz, Sam Cole" } });
    case "get_short_epg": {
      const id = Number(query.get("stream_id"));
      const start = Math.floor(now() / 1800) * 1800 - 1800 * (id % 2);
      return json({ epg_listings: Array.from({ length: 8 }, (_, k) => ({
        title: b64(shows[(id + k) % shows.length]), description: b64(k % 2 ? "" : "The latest from around the country, with sport and weather."),
        start_timestamp: String(start + k * 1800 * (1 + (k % 2))), stop_timestamp: String(start + (k + 1) * 1800 * (1 + (k % 2))),
      })).map((p, k, all) => (k ? { ...p, start_timestamp: all[k - 1].stop_timestamp } : p)) });
    }
    default: return json([]);
  }
}
