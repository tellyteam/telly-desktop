#!/usr/bin/env bash
# Builds the small FFmpeg that telly bundles to play MKV films: it repacks them into MP4 as they
# stream (video copied untouched; audio copied, or converted to AAC when the Mac can't play it).
#
# Only the pieces that needs are enabled, so it's a few MB rather than ~80. LGPL only (no
# --enable-gpl or --enable-nonfree), which is compatible with telly's GPL-3.0.
#
# Output: src-tauri/binaries/ffmpeg-{aarch64,x86_64,universal}-apple-darwin (Tauri sidecars).
# Usage: scripts/build-ffmpeg.sh            (both architectures, then a universal binary)
#        scripts/build-ffmpeg.sh aarch64    (just one, for development)
set -euo pipefail

VERSION=8.1.3
SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
MACOS_MIN=11.0

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/src-tauri/binaries"
WORK="${FFMPEG_BUILD_DIR:-$ROOT/.ffmpeg-build}"
ARCHES=("${@:-aarch64 x86_64}")
read -r -a ARCHES <<< "${ARCHES[*]}"

mkdir -p "$WORK" "$OUT"
TARBALL="$WORK/ffmpeg-$VERSION.tar.xz"
if [[ ! -f "$TARBALL" ]]; then
  curl -sSfL "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz" -o "$TARBALL.part"
  mv "$TARBALL.part" "$TARBALL"
fi
echo "$SHA256  $TARBALL" | shasum -a 256 -c -

# What telly needs, and nothing else.
FEATURES=(
  --disable-everything --disable-autodetect --disable-doc --disable-debug
  --disable-ffplay --disable-ffprobe --disable-swscale --disable-avdevice
  --enable-static --disable-shared
  # Reading: from telly's own relay on 127.0.0.1, so plain HTTP is all it needs.
  --enable-network --enable-protocol=http,tcp,file,pipe
  --enable-demuxer=matroska,mov,avi,mpegts,flv,asf
  --enable-muxer=mp4,mov
  --enable-parser=h264,hevc,av1,vp9,aac,ac3,mpegaudio,dca,opus,vorbis,flac
  --enable-bsf=aac_adtstoasc,extract_extradata,hevc_mp4toannexb,h264_mp4toannexb,vp9_superframe
  # Audio the Mac can't play in MP4 is decoded and re-encoded as AAC.
  --enable-decoder=aac,ac3,eac3,dca,truehd,mlp,mp2,mp3,opus,vorbis,flac,alac,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_s16be,pcm_bluray,pcm_dvd
  --enable-encoder=aac
  --enable-filter=aresample,aformat,anull,null,abuffer,abuffersink,buffer,buffersink
  --enable-swresample
  # Text subtitles carried into the MP4, where the Mac shows them as captions.
  --enable-decoder=subrip,ass,ssa,webvtt,text,movtext
  --enable-encoder=movtext
)

build_arch() {
  local arch=$1 triple="$1-apple-darwin"
  local src="$WORK/src-$arch"
  rm -rf "$src" && mkdir -p "$src"
  tar -xf "$TARBALL" -C "$src" --strip-components=1
  local clang_arch=$arch; [[ $arch == aarch64 ]] && clang_arch=arm64
  (
    cd "$src"
    ./configure "${FEATURES[@]}" \
      --arch="$arch" --target-os=darwin --enable-cross-compile \
      --cc="clang -arch $clang_arch" --disable-x86asm \
      --extra-cflags="-mmacosx-version-min=$MACOS_MIN" \
      --extra-ldflags="-mmacosx-version-min=$MACOS_MIN" \
      --pkg-config=false > configure.log
    make -j"$(sysctl -n hw.ncpu)" ffmpeg > make.log
  )
  cp "$src/ffmpeg" "$OUT/ffmpeg-$triple"
  strip -x "$OUT/ffmpeg-$triple"
  echo "built $OUT/ffmpeg-$triple ($(du -h "$OUT/ffmpeg-$triple" | cut -f1))"
}

for arch in "${ARCHES[@]}"; do build_arch "$arch"; done

if [[ -f "$OUT/ffmpeg-aarch64-apple-darwin" && -f "$OUT/ffmpeg-x86_64-apple-darwin" ]]; then
  lipo -create "$OUT/ffmpeg-aarch64-apple-darwin" "$OUT/ffmpeg-x86_64-apple-darwin" -output "$OUT/ffmpeg-universal-apple-darwin"
  echo "built $OUT/ffmpeg-universal-apple-darwin ($(du -h "$OUT/ffmpeg-universal-apple-darwin" | cut -f1))"
fi
