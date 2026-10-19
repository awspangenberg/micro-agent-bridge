# Codex Micro controls and the events they send

Captured on 2026-10-19 with `standalone-control.mjs watch-input`, on firmware 0.6.2 over Bluetooth.
The capture used the profile left by setup: layer 1 kept Codex's native mapping, layer 2 had
`KC_NONE` lower controls, and layer 3 used `KV_OAI_ACT*` codes.

## Physical layout

A 4 x 4 grid inside a frosted rim. The rim is the ambient light ring.

| Row | Column 1 | Column 2 | Column 3 | Column 4 |
|---|---|---|---|---|
| 1 | Knob (turn, press, hold) | Task key 1 | Task key 2 | Joystick |
| 2 | Task key 3 | Task key 4 | Task key 5 | Task key 6 |
| 3 | Bolt | Check | Cross | Branch |
| 4 | Layer button (touch), with three layer LEDs | Microphone (spans 2 columns, two switches) | Microphone | Last key |

The layer button sends no event. The current layer appears as `layer_index` in `device.status`
(0 to 2) and as `l` in `kb.radial` notifications.

## Events by layer

Key events arrive as `v.oai.hid {k, act}`, where `act` is 1 for press and 0 for release. Knob
turns on layer 1 arrive as `act: 2`, one event per detent. The microphone key reports both of
its switches together, so a press and hold yields two press events, then two release events.

| Control | Layer 1 (Codex, native) | Layer 3 (Mixed) | Layer 2 (Claude, after setup) |
|---|---|---|---|
| Bolt, check, cross, branch | ACT06, ACT07, ACT08, ACT09 | ACT13, ACT14, ACT15, ACT16 | none (`KC_NONE`) |
| Microphone | ACT10 + ACT11 | ACT17 + ACT18 | none |
| Last key | ACT12 | ACT19 | none |
| Knob counter-clockwise / clockwise | ENC_CC / ENC_CW (`act: 2`) | ACT00 / ACT01 (press and release per detent) | none |
| Knob press | ENC_CLK (press, release; hold is measurable) | ACT02 (press, release) | none |
| Joystick | `v.oai.rad {a, d}` stream; `{a: 0, d: 0}` on release | ACT04 left, ACT05 right, ACT20 down, ACT03 up (radial sectors), with `kb.radial` | `kb.radial {a, d, s, l, o}` only |

Codex's own control settings live in `~/.codex/config.toml` under
`[desktop.codex-micro-layout]`, keyed by these slot names. ACT06 FAST, ACT07 APPR, ACT08 REJ,
ACT09 SPLIT and ACT10_ACT11 MIC are the keycap roles. `analogStick.up`/`right`/`down`/`left` are
command IDs, and `encoderMode` selects what the knob does.
