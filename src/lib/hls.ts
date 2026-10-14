/**
 * Points every URI in an HLS playlist at the relay. The app's relay (Rust) has its own copy; this
 * one serves `npm run dev` in a browser, and the tests keep the two in step.
 */
export function rewritePlaylist(text: string, playlistUrl: string, wrap: (url: string) => string): string {
  const join = (u: string) => {
    try {
      return new URL(u, playlistUrl).toString();
    } catch {
      return undefined;
    }
  };
  return text.replace(/\r?\n$/, "").split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith("#")) {
      return t.replace(/URI="([^"]*)"/g, (whole, value: string) => {
        const u = value.startsWith("data:") ? undefined : join(value);
        return u ? `URI="${wrap(u)}"` : whole;
      });
    }
    const u = join(t);
    return u ? wrap(u) : t;
  }).join("\n") + "\n";
}
