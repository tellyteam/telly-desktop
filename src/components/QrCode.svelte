<script lang="ts">
  import qrcode from "qrcode-generator";

  /** A QR code as crisp SVG: black on white with a quiet margin, so cameras read it off a screen. */
  let { text, size = 168 }: { text: string; size?: number } = $props();

  const qr = $derived.by(() => {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    let path = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`;
    return { n, path };
  });
</script>

<svg class="qr" width={size} height={size} viewBox="-2 -2 {qr.n + 4} {qr.n + 4}" shape-rendering="crispEdges" role="img" aria-label="QR code to link another device">
  <rect x="-2" y="-2" width={qr.n + 4} height={qr.n + 4} fill="#fff" />
  <path d={qr.path} fill="#000" />
</svg>

<style>
  .qr { border-radius: 8px; flex: none; }
</style>
