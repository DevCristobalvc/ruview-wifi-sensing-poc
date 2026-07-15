//! RuView RSSI sensor — real WiFi signal streamer for the PoC.
//!
//! Polls the Windows WLAN service's cached BSS list through the native
//! `wlanapi.dll` FFI exposed by `wifi-densepose-wifiscan` (no `netsh`
//! text parsing, so it is locale-independent) and prints one JSON line
//! per scan to stdout. The backend consumes this stream and derives
//! motion / presence from the RSSI variance across access points.
//!
//! Usage:
//!   ruview-rssi-sensor [interval_ms]   # default 250 ms (4 Hz)

use std::io::Write;
use std::process::Command;
use std::thread;
use std::time::Duration;

use wifi_densepose_wifiscan::WlanApiScanner;

fn json_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Windows only keeps neighbouring BSSes in its scan cache for a short while
/// after the last scan; left alone it decays to just the associated AP. This
/// background thread nudges the WLAN service to refresh the full neighbour
/// list every few seconds (the text output is discarded — we only want the
/// side effect, so it is locale-independent), keeping multi-AP sensing alive.
fn spawn_scan_warmer() {
    thread::spawn(|| loop {
        let _ = Command::new("netsh")
            .args(["wlan", "show", "networks", "mode=bssid"])
            .output();
        thread::sleep(Duration::from_secs(4));
    });
}

fn main() {
    let interval_ms: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(250);

    eprintln!(
        "[sensor] native_available={} interval={}ms",
        WlanApiScanner::native_available(),
        interval_ms
    );

    spawn_scan_warmer();
    let scanner = WlanApiScanner::new();
    let stdout = std::io::stdout();

    loop {
        match scanner.scan_native() {
            Ok(obs) => {
                let mut out = String::from("{\"bssids\":[");
                for (i, o) in obs.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    let b = o.bssid.0;
                    let mac = format!(
                        "{:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
                        b[0], b[1], b[2], b[3], b[4], b[5]
                    );
                    out.push_str(&format!(
                        "{{\"bssid\":\"{}\",\"ssid\":\"{}\",\"rssi_dbm\":{:.1},\"signal_pct\":{:.1},\"channel\":{},\"band\":\"{:?}\"}}",
                        mac,
                        json_escape(&o.ssid),
                        o.rssi_dbm,
                        o.signal_pct,
                        o.channel,
                        o.band
                    ));
                }
                out.push_str("]}");
                let mut lock = stdout.lock();
                let _ = writeln!(lock, "{out}");
                let _ = lock.flush();
            }
            Err(e) => {
                eprintln!("[sensor] scan error: {e}");
            }
        }
        thread::sleep(Duration::from_millis(interval_ms));
    }
}
