// Writes the app icons (icons/) and the tray art from lib/icons.ts, so every PNG has a source:
//   denext task icons
// public/tray.png is the config's first-frame tray icon (the macOS template; desktop.ts replaces it
// per OS at once). icons/tray-*.png are previews of each OS's art (the app draws them at run time).
import { appIconPng, icoFromPngs, macTrayPixels, winTrayPixels } from "../lib/icons.ts";
import { encodePng } from "../lib/png.ts";

await Deno.writeFile("icons/app.png", await appIconPng(1024));
const sizes = [16, 32, 48, 256];
await Deno.writeFile(
  "icons/app.ico",
  icoFromPngs(
    await Promise.all(sizes.map(async (size) => ({ size, png: await appIconPng(size) }))),
  ),
);
await Deno.writeFile("public/tray.png", await encodePng(36, 36, macTrayPixels("normal")));
for (const status of ["normal", "alert"] as const) {
  await Deno.writeFile(
    `icons/tray-macos-${status}.png`,
    await encodePng(36, 36, macTrayPixels(status)),
  );
  for (const theme of ["light", "dark"] as const) {
    await Deno.writeFile(
      `icons/tray-windows-${theme}-${status}.png`,
      await encodePng(32, 32, winTrayPixels(theme, status)),
    );
  }
}
