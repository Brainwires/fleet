// Fleet's marks, drawn as pixels: three job bars stacked like lanes, the top one a short "running"
// bar with a status pip. The tray mark comes in a light-menu-bar ink, a dark-menu-bar ink, and red
// (a pool unhealthy, or a job queued over 15 min). The app icon is the same mark on a dark tile.

import { encodePng } from "./png.ts";

type Rgba = readonly [number, number, number, number];

/** A shape in unit coordinates (0..1); a `null` colour erases (a cut-out). */
interface Shape {
  readonly inside: (x: number, y: number) => boolean;
  readonly color: Rgba | null;
}

/** A rounded rectangle. */
function rect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  color: Rgba | null,
): Shape {
  return {
    color,
    inside: (x, y) => {
      if (x < x0 || x > x1 || y < y0 || y > y1) return false;
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
    },
  };
}

function circle(cx: number, cy: number, r: number, color: Rgba | null): Shape {
  return { color, inside: (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r };
}

/** Rasterize shapes (later over earlier; a null colour erases) with 4×4 supersampling. */
function raster(size: number, shapes: readonly Shape[]): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const S = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px + (sx + 0.5) / S) / size;
          const y = (py + (sy + 0.5) / S) / size;
          let c: Rgba | null = null;
          for (const s of shapes) if (s.inside(x, y)) c = s.color;
          if (!c) continue;
          const ca = c[3] / 255;
          r += c[0] * ca;
          g += c[1] * ca;
          b += c[2] * ca;
          a += ca;
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
      }
      out[i + 3] = Math.round((a / (S * S)) * 255);
    }
  }
  return out;
}

/** The mark's bars inside a box (unit coordinates). */
function mark(ox: number, oy: number, s: number, ink: Rgba, pip: Rgba, dim: Rgba): Shape[] {
  const bar = (row: number, w: number, c: Rgba) =>
    rect(ox, oy + row * 0.36 * s, ox + w * s, oy + (row * 0.36 + 0.22) * s, 0.11 * s, c);
  return [
    bar(0, 0.62, ink),
    circle(ox + 0.86 * s, oy + 0.11 * s, 0.11 * s, pip),
    bar(1, 1, dim),
    bar(2, 0.8, dim),
  ];
}

/** A tray icon's status: normal, or alert (a pool unhealthy, a job queued over 15 min). */
export type TrayStatus = "normal" | "alert";

const BLACK: Rgba = [0, 0, 0, 255];

/**
 * The macOS menu-bar mark: a TEMPLATE image, black on transparent only (macOS tints it for light and
 * dark menu bars and the highlight), 36 px (18 pt @2x). Status is shape, not colour: on alert a solid
 * badge sits in the top-right corner, cut out of the bars with a clear ring, and the top bar shortens.
 */
export function macTrayPixels(status: TrayStatus, size = 36): Uint8Array {
  const bar = (y0: number, x1: number) => rect(0.1, y0, x1, y0 + 0.16, 0.08, BLACK);
  if (status === "normal") {
    return raster(size, [bar(0.2, 0.62), bar(0.44, 0.9), bar(0.68, 0.76)]);
  }
  return raster(size, [
    bar(0.2, 0.5),
    bar(0.44, 0.9),
    bar(0.68, 0.76),
    circle(0.78, 0.26, 0.21, null), // the clear ring
    circle(0.78, 0.26, 0.14, BLACK), // the badge
  ]);
}

/** Windows (and Linux) variants: for a light or a dark taskbar. */
export type TaskbarTheme = "light" | "dark";

const WIN_INK: Record<TaskbarTheme, { ink: Rgba; dim: Rgba }> = {
  light: { ink: [24, 26, 30, 255], dim: [92, 100, 116, 255] },
  dark: { ink: [236, 238, 242, 255], dim: [160, 168, 182, 255] },
};
const PIP_OK: Rgba = [46, 184, 120, 255];
const RED: Rgba = [229, 56, 59, 255];

/**
 * The Windows / Linux tray mark: full colour, 32 px. Normal: neutral bars with a green status pip;
 * alert: the bars red with a red pip (and the tooltip says why).
 */
export function winTrayPixels(theme: TaskbarTheme, status: TrayStatus, size = 32): Uint8Array {
  const { ink, dim } = WIN_INK[theme];
  return status === "alert"
    ? raster(size, mark(0.12, 0.17, 0.76, RED, RED, RED))
    : raster(size, mark(0.12, 0.17, 0.76, ink, PIP_OK, dim));
}

/** One tray look: the icon, and the dark-mode icon (`null` for a macOS template). */
export interface TrayLook {
  readonly icon: Uint8Array;
  readonly iconDark: Uint8Array | null;
}

/** The tray's looks for an OS: normal and alert. */
export interface TrayIcons {
  readonly normal: TrayLook;
  readonly alert: TrayLook;
}

/** The tray icons for an OS (`Deno.build.os`): macOS templates, Windows / Linux colour art. */
export async function trayIcons(os: string): Promise<TrayIcons> {
  if (os === "darwin") {
    return {
      normal: { icon: await encodePng(36, 36, macTrayPixels("normal")), iconDark: null },
      alert: { icon: await encodePng(36, 36, macTrayPixels("alert")), iconDark: null },
    };
  }
  const look = async (status: TrayStatus): Promise<TrayLook> => ({
    icon: await encodePng(32, 32, winTrayPixels("light", status)),
    iconDark: await encodePng(32, 32, winTrayPixels("dark", status)),
  });
  return { normal: await look("normal"), alert: await look("alert") };
}

/** The app icon as a PNG: the mark on a dark rounded tile with a green pip. */
export function appIconPng(size: number): Promise<Uint8Array> {
  const tile = rect(0.06, 0.06, 0.94, 0.94, 0.2, [17, 21, 28, 255]);
  const shapes = [
    tile,
    ...mark(0.22, 0.27, 0.56, [120, 190, 255, 255], [62, 207, 142, 255], [86, 98, 120, 255]),
  ];
  return encodePng(size, size, raster(size, shapes));
}

/** A Windows .ico holding PNG images (Vista+ reads PNG entries). */
export function icoFromPngs(images: readonly { size: number; png: Uint8Array }[]): Uint8Array {
  const header = 6 + 16 * images.length;
  const total = header + images.reduce((n, i) => n + i.png.length, 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint16(2, 1, true);
  v.setUint16(4, images.length, true);
  let offset = header;
  images.forEach((img, k) => {
    const e = 6 + 16 * k;
    out[e] = img.size >= 256 ? 0 : img.size;
    out[e + 1] = img.size >= 256 ? 0 : img.size;
    v.setUint16(e + 4, 1, true);
    v.setUint16(e + 6, 32, true);
    v.setUint32(e + 8, img.png.length, true);
    v.setUint32(e + 12, offset, true);
    out.set(img.png, offset);
    offset += img.png.length;
  });
  return out;
}
