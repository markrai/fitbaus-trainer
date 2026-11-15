# Arcade release blockers

## LGPL-2.1 static libusb

`libfitbaus_arcade_hand.so` statically links libusb 1.0.30 (LGPL-2.1-or-later).

Before any production publish/distribution of the Native Bridge APK that includes this
library, Fitbaus must ship or offer the corresponding **relink materials** (object files
or equivalent) so recipients can replace libusb, and must keep the pinned libusb source
available. See `src/main/assets/licenses/arcade/NOTICE.txt` and `LGPL-2.1.txt`.

This file documents the obligation only; it is not a complete release-publishing checklist.
