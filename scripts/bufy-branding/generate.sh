#!/usr/bin/env bash
# Bufy fork: regenerate every branded raster asset of the desktop app (app icons, tray/menu bar icons, DMG background,
# update thumbnail) from the planet-mining branding sources. Needs google-chrome (headless) and ImageMagick 7 (`magick`).
# Usage: scripts/bufy-branding/generate.sh [path to planet-mining/assets/branding]
set -euo pipefail
G=$(cd "$(dirname "$0")" && pwd)
R=$(cd "$G/../.." && pwd); A=$R/src/assets
B=${1:-$R/../planet-mining/assets/branding}
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
# icon-1024.png in the game repo has an opaque white background behind the rounded tile; render icon.svg transparent instead
ICON=$W/icon-1024.png
timeout -k 5 60 google-chrome --headless=new --user-data-dir="$W/chrome-prof" --hide-scrollbars --default-background-color=00000000 \
  --screenshot="$ICON" --window-size=1024,1024 "file://$B/icon.svg" </dev/null >/dev/null 2>&1
python3 "$G/tray.py" "$W"
cp "$W/tray.svg" "$W/tray_mention.svg" "$W/tray_unread.svg" "$R/resources/windows/"

# --- app icons ---
magick "$ICON" -define icon:auto-resize=256,128,64,48,32,16 "$A/icon.ico"
python3 "$G/icns.py" "$A/icon.icns" "$ICON"
magick "$ICON" -resize 512x512 -background none -gravity center -extent 512x525 "PNG32:$A/linux/app_icon.png"
magick "$ICON" -resize 48x48 "PNG32:$A/appicon_48.png"
magick "$ICON" -resize 26x26 -background none -gravity center -extent 32x32 "PNG32:$A/appicon_with_spacing_32.png"

# --- tray / menu bar: colorize the 512 px masks ---
col() { # mask color alpha out
  magick -size 512x512 "xc:$2" \( "$W/$1_512.png" -alpha extract \) -alpha off -compose CopyOpacity -composite \
    -channel A -evaluate multiply "$3" +channel "PNG32:$4"
}
variant() { # name markColor markAlpha badgeColor|none
  if [ "$4" = none ]; then col mark "$2" "$3" "$W/$1.png"
  else col markgap "$2" "$3" "$W/$1_m.png"; col badge "$4" 1 "$W/$1_b.png"
       magick "$W/$1_m.png" "$W/$1_b.png" -compose over -composite "PNG32:$W/$1.png"; fi
}
RED='#FF3B30'; BLUE='#579EFF'
for th in dark:#323130:1 light:#FFFFFF:1; do
  IFS=: read -r n c a <<<"$th"
  for v in "":none _mention:$RED _unread:$BLUE; do
    IFS=: read -r suf bc <<<"$v"
    variant "lx_$n$suf" "$c" "$a" "$bc"
    magick "$W/lx_$n$suf.png" -resize 16x16 "PNG32:$A/linux/top_bar_${n}${suf}_16.png"
    magick "$W/lx_$n$suf.png" -resize 32x32 "PNG32:$A/linux/top_bar_${n}${suf}_16@2x.png"
  done
done
for th in dark:#000000:0.7 light:#FFFFFF:0.9; do
  IFS=: read -r n c a <<<"$th"
  for v in "":none _mention:$RED _unread:$BLUE; do
    IFS=: read -r suf bc <<<"$v"
    variant "win_$n$suf" "$c" "$a" "$bc"
    imgs=(); for px in 16 24 32 48 64; do magick "$W/win_$n$suf.png" -resize ${px}x${px} "PNG32:$W/win_$n${suf}_$px.png"; imgs+=("$W/win_$n${suf}_$px.png"); done
    magick "${imgs[@]}" "$A/windows/tray_${n}${suf}.ico"
  done
done
variant mac '#000000' 1 none; variant mac_unread '#000000' 1 '#000000'
for px in 16 20 24 32; do
  magick "$W/mac.png" -resize ${px}x${px} "PNG32:$A/osx/menuIcons/MenuIcon${px}Template.png"
  magick "$W/mac.png" -resize $((px*2))x$((px*2)) "PNG32:$A/osx/menuIcons/MenuIcon${px}Template@2x.png"
  magick "$W/mac_unread.png" -resize ${px}x${px} "PNG32:$A/osx/menuIcons/MenuIconUnread${px}Template.png"
  magick "$W/mac_unread.png" -resize $((px*2))x$((px*2)) "PNG32:$A/osx/menuIcons/MenuIconUnread${px}Template@2x.png"
done

# --- downloads dropdown "app update" thumbnail ---
magick "$ICON" -resize 64x64 -strip "PNG32:$W/thumb64.png"
printf '<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><image width="32" height="32" href="data:image/png;base64,%s"/></svg>\n' \
  "$(base64 -w0 "$W/thumb64.png")" > "$A/thumbnails/mattermost.svg"

# --- macOS DMG background ---
timeout -k 5 60 google-chrome --headless=new --user-data-dir="$W/chrome-prof" --hide-scrollbars --screenshot="$W/dmg.png" \
  --window-size=542,353 "file://$G/dmg_bg.svg" </dev/null >/dev/null 2>&1
magick "$W/dmg.png" "PNG32:$A/osx/DMG_BG.png"
