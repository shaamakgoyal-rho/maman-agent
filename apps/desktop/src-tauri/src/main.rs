// Prevents an additional console window on Windows in release; harmless on macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    maman_desktop_lib::run()
}
