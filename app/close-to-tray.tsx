"use client";
// The main window's close button hides it (through the backend, so the Dock icon goes too): Fleet
// keeps polling in the tray until a real quit, which the guard lets through (`reason: "quit"`).

import { useEffect } from "denext";
import { currentWindowId, hideWindow, onCloseRequested } from "denext/desktop/window";
import { runtimePlatform } from "denext/mobile";
import { allowClose } from "../lib/tray-driver.ts";
import { fleet } from "./fleet-client.ts";

export function CloseToTray() {
  useEffect(() => {
    if (runtimePlatform() !== "desktop") return;
    let off: (() => void) | undefined;
    let stopped = false;
    void currentWindowId().then((id) => {
      if (id !== "main" || stopped) return;
      off = onCloseRequested(({ reason }) => {
        // A real quit (Cmd+Q, the tray's Quit, logout) goes through; the close button hides.
        if (allowClose(reason)) return true;
        void fleet.hide().catch(() => hideWindow().catch(() => {}));
        return false;
      });
    }).catch((err) => console.error("fleet: close-to-tray:", err));
    return () => {
      stopped = true;
      off?.();
    };
  }, []);
  return null;
}
