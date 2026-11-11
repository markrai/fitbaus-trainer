# History (retired host)

Bike Bridge on this console used to be a Classic Xamarin.Android app that
loaded proprietary Shire/iFIT assemblies to run `EquipmentConsole`. That host,
its C# HTTP layer, and the Xamarin/Shire toolchain are **removed from the
maintained codebase**. They are not a source of truth for current behavior
and must not be restored as the CI or development path.

A previously installed or preserved Legacy APK may still exist as a local
rollback artifact for emergency manual recovery (`adb install -r` with the
matching signing certificate). That does not put the Xamarin tree back in
Git, and it is not a supported build from this repository.

Native Kotlin under `native/` is the production runtime. Protocol facts that
still apply (USB IDs, MAIN vs FitnessBike=7 targeting, field-2 resistance,
board max 22 vs HTTP 1–15) live in [PROTOCOL.md](PROTOCOL.md) and
[ARCHITECTURE.md](ARCHITECTURE.md).

Do not restore the Xamarin project, Shire copy scripts, or a `dotnet test` CI
job unless Native itself is being replaced.
