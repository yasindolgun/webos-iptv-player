# Back navigation and app exit

The app handles the remote Back key itself because `appinfo.json` enables
`disableBackHistoryAPI`. Back always dismisses the most local active surface
before it can change the app route: prompts, dropdowns, player menus, catalog
details, and editors keep ownership of their own intermediate state.

At the top level, every section returns to Home. Entering Home through any
route clears an earlier exit confirmation, so a Back press used for navigation
can never double as the first half of an exit gesture.

## Exit contract

Home uses a custom two-press confirmation:

1. The first distinct Back press shows the localized exit hint.
2. A second distinct press within three seconds starts one exit operation.
3. Key-repeat events and any further presses while that operation is pending
   are ignored.
4. Pending durable user-data and cache writes are flushed before teardown. If
   the durable user-data flush and its recovery attempt both fail, the app
   stays open, clears the confirmation, and shows the save-failure message.
5. After a successful flush, playback is stopped, player overlays are closed,
   the EPG refresh timer is cleared, service requests and subscriptions are
   cancelled, and the bundled LAN service receives its bounded stop request.
6. Telemetry gets its bounded shutdown-delivery window, then `window.close()`
   terminates the app.

LG's [Back Button guide](https://webostv.developer.lge.com/develop/guides/back-button)
specifies `window.close()` for apps that implement a custom exit prompt.
`webOS.platformBack()` is intentionally not used: it would add the platform's
version-dependent prompt on webOS 6+ and only launch Home on webOS 5 and
earlier.

## Validation

Automated coverage checks view-to-Home navigation, overlay ownership, ignored
key repeats, confirmation timeout/reset, one exit operation during delayed
persistence, save-failure recovery, and explicit player/service/subscription
cleanup. Both Playwright projects exercise the same contract.

Release qualification still requires a physical webOS 4 run. Record the TV
model, firmware, app version and bundle hash while checking cold launch, exit,
relaunch, suspend/resume, a held Back key, and delayed or failed persistence.
The Chromium 53 project cannot prove native window or lifecycle behavior.
