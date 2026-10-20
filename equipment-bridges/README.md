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

That bridge is optional. FitBaus Trainer runs without it. Its classic
Xamarin.Android requirements, LAN security boundary, and third-party runtime
policy are documented in its own README.

Future bridges may cover bikes, treadmills, rowers, ellipticals, or other
machines. Each bridge owns its own build and device packaging story.

## Proprietary runtimes

Do not commit proprietary vendor runtime components (for example Shire/iFIT-era
assemblies) unless redistribution rights explicitly permit it. Bridges that
depend on such components must document how a developer supplies them locally.
