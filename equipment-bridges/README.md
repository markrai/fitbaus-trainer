# Equipment bridges

Equipment bridges integrate FitBaus Trainer with specific exercise equipment
over a trusted local network (or similar local transport).

Each bridge is **model-specific**. Implementations may use entirely different
hardware stacks, toolchains, and vendor runtimes. This folder is the generic
repository organization — it does **not** imply one universal hardware protocol
or a shared `EquipmentBridge` source API.

## Current support

| Bridge | Path |
| --- | --- |
| ProForm Smart Power 10.0 | [proform-smart-power-10/](proform-smart-power-10/) |

That bridge is optional. FitBaus Trainer runs without it. Production runtime is
Native Kotlin (`proform-smart-power-10/native/`). LAN pairing, USB
authentication, and resistance safety are documented in that tree's README.

Shared Arcade HUD sources live in [shared/arcade/](shared/arcade/) and are
consumed by the Native host. Arcade does not own USB or resistance.

Future bridges may cover bikes, treadmills, rowers, ellipticals, or other
machines. Each bridge owns its own build and device packaging story.

## Proprietary runtimes and secrets

Do not commit proprietary vendor runtime components, signing keystores, or
device pairing tokens. Bridges that need local secrets must document how a
developer supplies them (for example `native/local.properties`).
